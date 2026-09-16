# Entornos

Cuatro ramas de Neon, cuatro propósitos que no se mezclan. **Ninguna se borra nunca**
(regla dura del `CLAUDE.md`); la que haga falta reponer se rehace clonándola de su padre.

| Rama         | Para qué                                       | Quién la usa                   | Datos                                |
| ------------ | ---------------------------------------------- | ------------------------------ | ------------------------------------ |
| `production` | La empresa. **Datos reales desde 2026-09-07.** | Vendedores, planta, el dueño   | Reales. No se ensucian ni se purgan. |
| `demo`       | Ensayos, capacitación y carga de prueba        | El dueño y quien esté probando | Copia de `production` al 2026-09-06  |
| `dev`        | Desarrollo local del día a día                 | El agente y el dueño en local  | Descartables                         |
| `ci`         | La suite E2E completa en GitHub Actions        | CI                             | Se resetea en cada corrida           |

## production

- API en Cloud Run `us-central1`, web en Vercel; el web llama al API por `/api/*` (D-015, D-022).
- Migraciones y seed: `pnpm db:prod` (solo `migrate deploy`, nunca `reset`).
- **Verificación post-deploy: `pnpm smoke:prod`** — solo lectura. Ver abajo.
- **Diagnóstico de precios: `pnpm check:price-floor --branch production`** — solo lectura
  (D-163/D-164). Lista los SKU activos cuyo precio de lista quedó por debajo del piso duro.
  Es el insumo para decidir el aviso de mínimo en el mostrador; no escribe nada. Con
  `--branch local` o `--branch local-e2e` corre contra las bases de Docker.
- Nunca se usa la cuenta real del dueño para verificar nada: se crea un ADMINISTRADOR
  efímero `e2e-...@ayr.test` y se borra al terminar (D-024).
- **`PSE_ENABLED` (D-216): sin definir en `production`, a propósito.** Es el apagado
  explícito de toda emisión electrónica —factura, boleta, nota de crédito, GRE,
  anulación, consulta de estado— mientras dura la migración (D-153: prod solo opera
  comprobantes manuales). Con el flag apagado, el API rechaza **antes** de tomar
  correlativo, con un mensaje de negocio claro; no depende de que `NUBEFACT_URL`/
  `NUBEFACT_TOKEN` falten (eso sigue siendo la contingencia normal de D-073, para
  cuando el PSE esté habilitado y el proveedor no responda). Se define `PSE_ENABLED=true`
  en `dev` (`scripts/write-local-env.mjs`, heredado por `demo` vía `apps/api/.env`) y en
  `ci` (los dos jobs de `.github/workflows/ci.yml`) para que ningún entorno de prueba
  cambie de comportamiento. Verificar en `smoke:prod` que quedó apagado tras un deploy.

## demo

Existe para lo que antes se hacía contra producción: ensayar el flujo completo, capacitar a
un vendedor, cargar datos de prueba y romperlos sin consecuencias.

```
pnpm env:demo    # escribe .env.demo con la conexión a la rama demo (no se commitea)
pnpm db:demo     # migraciones + seed en demo
pnpm dev:demo    # levanta api :3000 + web :3001 contra demo
```

`pnpm dev:demo` **no toca** `apps/api/.env`: inyecta la conexión por variables de entorno al
proceso, así que `pnpm dev` sigue apuntando a `dev` y las dos cosas conviven. `.env.demo` está
cubierto por el `.env.*` del `.gitignore`.

### Demo tiene secretos propios, y eso no es opcional

`.env.demo` lleva su **propio** `JWT_SECRET` y su **propia** contraseña de administrador,
generados al azar por `pnpm env:demo`. Nunca los de producción.

El motivo es concreto: demo es un **clon** de production, así que trae sus mismos usuarios, sus
mismos ids de sesión y sus mismos hashes. El `AuthGuard` acepta cualquier JWT bien firmado cuyo
`sid` exista y no esté revocado — todos datos legibles desde el clon. Con el secreto compartido,
cualquiera con acceso a demo (o a este archivo) podría **acuñar un token que producción acepta**,
sin conocer ninguna contraseña. Por eso `pnpm db:demo` además **borra siempre las sesiones
heredadas** (`prisma/demo-purge-sessions.sql`): es la única pieza del clon que serviría para
cruzar de un entorno al otro.

### Rehacer demo desde producción

Cuando demo quede sucia de un ensayo, se reinicia la rama desde su padre con el CLI de Neon
(nunca borrando tablas a mano) y **acto seguido**:

```
pnpm env:demo    # si querés rotar también los secretos de demo, borrá antes .env.demo
pnpm db:demo     # migraciones + purga de sesiones heredadas + seed del admin de demo
```

El segundo paso **no se puede saltear**: sin él, la copia recién hecha conserva las sesiones
vivas de usuarios reales.

## dev

`pnpm env:local` genera `apps/api/.env` y `apps/web/.env.local`; `pnpm dev`, `pnpm db:migrate`,
`pnpm db:seed`. Es la única rama contra la que se corre `prisma migrate dev`.

## local (Docker) — no es Neon

Un Postgres 100% local (`docker-compose.yml`), sin cuenta de Neon ni `.env.setup`: sirve para
desarrollar sin red y para que la suite E2E corra rápido y aislada. Nunca reemplaza a `dev`
(la rama Neon sigue siendo donde se prueba contra el motor real antes de un deploy), pero para
el día a día alcanza y es mucho más rápido.

Un solo contenedor, dos bases (`docker/postgres-init`): `ayr_local` para `pnpm dev:local` y
`ayr_local_e2e`, exclusiva de la suite, que se vacía en cada corrida — así una no pisa a la
otra. El puerto es `5434` (no 5433: ver `scripts/local-docker-env.mjs` si algún día choca con
otra cosa en el equipo).

```
pnpm dev:local                # Postgres (docker compose) + migrate deploy + seed + api :3000 + web :3001
pnpm dev:preview              # segundo api+web (api :4000, web :4001) contra la MISMA base "ayr_local",
                              # para que el dueño mire la app sin tocar los procesos del agente
pnpm db:local reset           # borra el volumen entero y repone migrate+seed
pnpm db:local snapshot <n>    # pg_dump de "ayr_local" a local-data/db-local-snapshots/<n>.sql
pnpm db:local restore <n>     # restaura ese volcado sobre "ayr_local"
pnpm e2e                      # por defecto ahora corre contra "ayr_local_e2e" (ver abajo)
```

### Puertos: quién usa cuáles

`3000` (api) y `3001` (web) son del **agente** y de Playwright: `pnpm dev:local` y `pnpm e2e`
viven ahí, y una corrida de la suite mata y relevanta esos procesos.

`4000` (api) y `4001` (web) son del **dueño**: `pnpm dev:preview` los levanta contra la misma
`ayr_local` para poder mirar la app en el navegador mientras el agente trabaja. El agente
nunca los usa ni los mata (regla dura 15 de `CLAUDE.md`). La cuenta de esa vista es
`viewer@ayr.local`, con contraseña propia que se reafirma en cada arranque, así que el flujo
de cambio obligatorio de contraseña (RF-03) del otro proceso no la deja afuera.

`pnpm dev:local` no toca `apps/api/.env`: el override de conexión viaja por entorno al proceso
hijo (regla dura 5), igual que `dev-demo.mjs`, así que `pnpm dev` (contra Neon `dev`) sigue
disponible en paralelo. Las credenciales del Postgres local están fijas y a la vista en
`scripts/local-docker-env.mjs` — no son secretas, son de una base descartable que nunca sale
de `localhost`.

### E2E con latencia: comparar el rendimiento de dos commits (F8-R1)

Docker responde en ~0 ms, así que una regresión que vive en **cantidad de round-trips** a la
base no se ve con `pnpm e2e` y aparece recién contra Neon. Para medirla de forma repetible hay
tres herramientas, todas locales y sin Neon:

- `scripts/latency-proxy.mjs`: proxy TCP delante del Postgres local que suma un retardo fijo
  por sentido y **cuenta los round-trips** (`Sync` del protocolo extendido más consultas
  simples). En Windows `setTimeout` redondea a ~15,6 ms: `--delay 1` da ~28 ms por consulta
  medido con Prisma, que es el valor a usar. Medir antes de confiar en otro.
- `scripts/e2e-latency.mjs`: corre la suite desde un **worktree** con builds de producción
  (`node dist/main.js` y `next start`), el pool limitado a 5 conexiones como en el runner de
  GitHub, y recrea `ayr_local_e2e` con el esquema de ese commit. Nunca usa `apps/web/.next` del
  repo principal, que es el de `pnpm dev:preview` del dueño.
- `scripts/e2e-roundtrips-reporter.mjs` (lo pone el runner) anota por test duración y
  round-trips en un `.jsonl`; `scripts/e2e-latency-compare.mjs` cruza dos corridas por spec.

```
git worktree add --detach ../wt-antes <commit>      # y otro para el después
pnpm --dir ../wt-antes install --frozen-lockfile
pnpm --dir ../wt-antes --filter @ayr/shared build
pnpm --dir ../wt-antes --filter @ayr/api db:generate
pnpm --dir ../wt-antes --filter @ayr/api build
pnpm --dir ../wt-antes --filter @ayr/web build       # con API_URL=http://localhost:3000
node scripts/latency-proxy.mjs --listen 5435 --delay 1 --stats-port 5499   # aparte, en background
node scripts/e2e-latency.mjs --worktree ../wt-antes --out local-data/r1/antes.jsonl [-- <specs>]
node scripts/e2e-latency-compare.mjs local-data/r1/antes.jsonl local-data/r1/despues.jsonl
```

Dos límites medidos: el worktree no tiene credenciales de PSE ni de R2, así que esos caminos
degradan igual en los dos commits; y un par de specs de UI con drawers fallan solo bajo
latencia porque la aserción llega antes de que el drawer cierre (ver
`docs/analisis/f8-r1-rendimiento.md`). Para limitar la CPU como en el runner, lanzar el runner
con `start "" /affinity 3 /wait /b node scripts/e2e-latency.mjs …` desde `cmd`.

Storage tipo R2 (los adjuntos de `imports`) es opcional: `docker compose --profile storage up
-d` levanta MinIO y `apps/api/.env` (o el entorno que uses) apunta `R2_ENDPOINT` a
`http://localhost:9000` con las credenciales de `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. Sin
esto, `StorageService` responde 503 — degradación ya prevista, no un fallo de arranque.

## ci

**Desde D-202, CI tiene dos jobs de E2E y solo uno toca Neon:**

- **`e2e` — la suite completa (`pnpm e2e`) contra un Postgres de servicio dentro del runner**
  (`postgres:17-alpine`, la misma imagen que Docker local; base `ayr_ci_e2e` en `localhost`).
  D-201 midió que la lentitud del E2E en CI era consultas × latencia runner→Neon, y esa latencia
  depende de la región donde GitHub asigna el runner: con la base en el mismo host, la duración
  vuelve a depender del código. La contraseña de esa base va en claro en `ci.yml` y no es un
  secreto: la base nace y muere con el job.
- **`smoke-neon` — lo que solo Neon valida, contra la rama Neon `ci`**: `prisma migrate deploy` y
  `migrate status` en un paso propio (si una migración no aplica en Neon, el rojo lo dice), el
  reset con su guard contra el endpoint real de la rama (D-181) y **`pnpm e2e:smoke`**, una
  docena de specs representativos listados con su motivo en `scripts/e2e-smoke.mjs`. Corre sin
  `NUBEFACT_*`: la emisión va por el camino sin PSE atado. Es el único job con
  `concurrency: neon-ci-branch`, porque la rama se resetea en cada corrida.

El guard de `apps/api/prisma/test-db-guard.ts` admite exactamente tres bases: `ayr_local_e2e`
en Docker local, `ayr_ci_e2e` en `localhost` **solo con `GITHUB_ACTIONS=true`**, y el endpoint de
la rama Neon `ci`. El host del runner es `localhost` y no el nombre del servicio (`postgres`)
porque el job corre en el runner, no en un contenedor: el servicio se alcanza por el puerto
mapeado.

**En local, `pnpm e2e` ya no toca Neon**: corre contra el Postgres de Docker de arriba
(base `ayr_local_e2e`), que también se vacía en cada corrida por default
(`E2E_RESET_DB=1`, seteado por `playwright.config.ts`). Exportar `DATABASE_URL`/`DIRECT_URL` a
mano antes de correr `pnpm e2e` sigue funcionando para apuntar a otra base puntualmente.

---

## La corrida por defecto no depende de nada externo

**Meta: `pnpm e2e` tiene que poder dar verde pleno sin llamar a ningún tercero.** Un rojo que no
es una regresión cuesta más que el caso que cubre: quien corre la suite deja de mirar los rojos
porque «esos son los de siempre», y el día que uno sea de verdad no lo va a ver. De ahí salen
las tres piezas de abajo.

### Los casos que necesitan el PSE corren aparte (`@pse`)

Doce casos —en `fase5b`, `fase5b-bordes` y `fase7b`— necesitan que un comprobante llegue a
**ACEPTADO**, y para eso hace falta cupo en la cuenta demo de Nubefact, que admite 50
comprobantes. Llena, esos doce fallan todos con «No puedes enviar mas de 50 documentos en en una
cuenta DEMO».

- Están etiquetados **`@pse`** en el título y **excluidos de `pnpm e2e`** (`grepInvert` en
  `playwright.config.ts`).
- Se corren aparte con **`pnpm e2e:pse`**, que pone `E2E_PSE=1` y con eso la suite corre
  exactamente el complemento. **Si la cuenta demo está cerca de los 50, antes hay que vaciarla**
  en el panel de Nubefact.
- **La numeración ya no obliga a vaciarla hasta 0 (D-202).** El reset deja las series en 0 y la
  cuenta demo recuerda los números que ya recibió, así que cada corrida volvía a mandar
  `F001-00000001` y chocaba con la anterior. Ahora `e2e/global-setup.ts`, tras el reset y el
  seed, corre `apps/api/prisma/e2e-fiscal-offset.ts`, que adelanta todas las series a
  `10 000 000 + (epoch en segundos mod 80 000 000)`: dos corridas no reusan números. El cupo de
  50 sigue siendo real; lo que deja de ser bloqueante es la numeración.
- El flag va por **entorno y no por `--grep`** porque un `--grep` de la línea de comandos pisa a
  `grep` pero **no** a `grepInvert`: con bandera, `e2e:pse` habría corrido cero casos.

**Por qué por etiqueta y no ampliando `probePse`.** La sonda ya saltea estos casos cuando no hay
PSE atado o falta el RUC del receptor: eso es _en este entorno no se puede llegar a una
aceptación_. Enseñarle además «…y tampoco si el servidor contestó que no hay cupo» sería
saltear casos según **la respuesta que dio el servidor**, y esa misma condición taparía una
regresión que hiciera fallar la emisión por cualquier otro motivo. La exclusión tiene que ser
una decisión escrita en la suite, no un heurístico sobre un mensaje de error.

### El padrón se responde con un stub local

`e2e/padron-stub.mjs` corre como tercer `webServer` en **`:3002`** y el API lo consulta vía
`APIS_NET_PE_BASE_URL`. Sirve el padrón de RUC (D-067), el de DNI y el tipo de cambio SUNAT
(D-029) — los tres caminos que el ERP usa de apis.net.pe.

Existe porque **el padrón se consulta del lado del API, no del navegador** (D-158: la fila manda
el documento y el nombre lo trae el servidor), así que un `page.route()` de Playwright nunca lo
interceptaba: la petición no sale del navegador. El badge «Nuevo — se creará desde padrón» era
la única rama de D-158 que ningún E2E podía ejercitar.

**Contrato del stub**, que es lo que deja elegir el caso sin listas que mantener: un documento
**existe** en el padrón si termina en dígito **par** (200 con `razonSocial: "PADRON STUB
<numero>"`) y **no existe** si termina en **impar** (404). Así un test elige a propósito la rama
del alta desde padrón o la del alta express (D-156).

De paso, la suite deja de gastar la cuota compartida del servicio real, que es la misma para el
padrón y para el tipo de cambio.

### La base de pruebas se vacía entera

`apps/api/prisma/reset-test-db.ts` trunca **todas** las tablas menos `_prisma_migrations`,
enumerándolas desde `information_schema`, y el seed repone lo que hace falta: líneas de negocio,
márgenes, administrador y el cliente **«público en general»** (D-077). El resultado es, tabla por
tabla, el estado de una base recién creada.

Hasta la sesión de saneamiento la lista era de nueve tablas escritas a mano y dejaba fuera
**todos los maestros**, que se acumulaban entre corridas: llegó a 1 874 proveedores, 841 colores,
2 902 productos, 1 576 acabados y 1 195 clientes. Eso producía dos cosas, las dos observadas:
`409` al azar en tests que no hablaban del maestro que chocó —`suppliers.code` es `VarChar(6)` y
los generadores sorteaban contra un maestro de miles de filas— y una pantalla que **cambiaba de
forma con la edad de la base** (el `SearchSelectField` de D-156 en modo modal o en modo
`<select>` según cuántos clientes hubiera).

Se enumera y no se lista a mano **a propósito**: la lista escrita a mano fue justamente lo que
envejeció. Un modelo nuevo entra solo al vaciado, que es el comportamiento correcto para una
base descartable.

**Y por eso el cliente «público en general» se mudó al seed.** Lo sembraba la migración de la
Fase 5b, y una migración corre una vez y no repone nada: al vaciar `customers`, el mostrador se
quedó sin a quién facturar. El seed responde otra pregunta —_qué necesita esta base para ser
usable_— y es idempotente, así que contra producción o demo no hace nada.

---

## La suite E2E no corre contra producción (D-126)

**`pnpm e2e:prod` queda prohibido como rutina.** Desde el 2026-09-07 producción tiene
inventario, comprobantes y cuentas reales, y la suite completa crea compras, bobinas, órdenes
de producción y despachos. El kardex es append-only (§3.2): parte de lo que la suite deja **no
se puede deshacer** sin una reversa de dominio — las fases 7d y 7e documentan el residuo exacto
que quedó las dos veces que se corrió. Contra una base vacía eso era un rastro molesto; contra
inventario real es contaminación del stock del cliente.

En su lugar:

- **Post-deploy: `pnpm smoke:prod`.** Health sin sesión, login con el admin efímero y cuatro o
  cinco GET (líneas, catálogo, inventario, bobinas, reporte mensual). Lo único que escribe es
  ese usuario efímero, y lo borra en `finally`.
- **La suite completa: local y CI**, contra Docker local y el Postgres del runner; el smoke,
  contra la rama Neon `ci` (D-202). Es la que manda antes de un push (D-123).
- **`pnpm prod:purge-e2e` queda solo para emergencias documentadas**: si algún día vuelve a
  entrar residuo E2E a producción, se usa una vez y se anota en `PROGRESO.md` por qué.

La regla no vive solo acá: `scripts/e2e-prod.mjs` **se niega a correr** salvo que se le pase
`AYR_ALLOW_E2E_PROD=1`, y el mensaje que muestra remite a `pnpm smoke:prod`. Una prohibición que
solo existe en un documento se saltea tecleando el comando de siempre.

---

## Checklist de ventana de deploy

Lo que las ventanas V-2 y V-3 hicieron a mano, en orden. Cada paso se anota en `PROGRESO.md`
con su resultado.

1. **CI verde en `main`** sobre el último commit del lote: jobs `calidad`, `e2e` (Postgres del
   runner) y `smoke-neon` (D-202). Un timeout no es un verde.
2. **Respaldo Neon** de `production` (rama `respaldo-pre-deploy-AAAAMMDD`), vía
   `scripts/lib.mjs#run` con `quiet: true` y `--output json` (regla dura 5).
3. **Migraciones pendientes** en `production`: `node scripts/migrations-status.mjs --branch
production`. Si alguna muta datos, se dice en `PROGRESO.md` cuál y qué hace.
4. **Gate PSE: `pnpm e2e:pse`** en local.
   - **Cupo:** si la cuenta demo de Nubefact está cerca de los 50 comprobantes, el dueño la
     vacía antes. Sigue en el checklist porque el cupo es real.
   - **Numeración: ya no es bloqueante (D-202).** Cada corrida parte de su propio correlativo,
     así que no hace falta dejar la cuenta en 0 exacto para no chocar con números viejos. Un
     rojo de «documento ya existe» después de D-202 **no** se acepta por clasificación: es un
     defecto.
   - **Rollover: el 2028-04-22.** El offset de D-202 es
     `10 000 000 + (epoch en segundos mod 80 000 000)`, y ese rango da la vuelta ese día: a
     partir de ahí los correlativos vuelven a empezar y hay que **vaciar la cuenta demo una
     vez** para que no choquen con números ya usados. Cita exacta en D-202
     (`docs/ARQUITECTURA.md` §0.2).
5. **Deploy:** `pnpm deploy:api` y verificar `/health`; web por push a `main` (Vercel).
6. **`pnpm smoke:prod`** (solo lectura, D-126). Nunca `pnpm e2e:prod`.

---

## Checklist de la ventana V-4 (limpia total + migraciones + inventario real)

La ventana más delicada del proyecto hasta ahora: vacía todo lo transaccional de `production`
(D-208, `pnpm limpia:v4`) y exige tipo en acabados (D-209) antes de cargar el inventario real
(D-206/D-207). Cada paso lleva quién lo hace — **dueño** o **agente** — y se anota en
`docs/PROGRESO.md` con su resultado, igual que la ventana de deploy de arriba. Todo lo de M1/M2
se ensayó de punta a punta contra una rama de ensayo de Neon clonada de `production`
(F8-V4prep, 2026-09-15): dry-run y `--execute` de la limpia, y las dos ramas de D-209 (acabados
completos y acabado sin tipo) — resultados en `docs/PROGRESO.md`, sesión F8-V4prep.

0. **[Agente] Suite verde de punta a punta.** `pnpm e2e` completo, 0 rojos — la deuda OOM de
   F8-S6a/F8-S6a2. Si el host no aguanta una corrida `dev`/`nest start` completa, correrla desde
   un `git worktree` con builds de producción (`next start` + `node dist/main.js`), como
   `scripts/e2e-latency.mjs` ya hace para F8-R1: nunca toca `apps/web/.next` del repo principal,
   así que no interfiere con `pnpm dev:preview` del dueño. **Gate PSE**: `pnpm e2e:pse` con los
   correlativos de 8 dígitos de D-202 — primera vez que se prueba que la cuenta demo de Nubefact
   los acepta como primer número de una serie; si los rechaza, D-202 se revisa antes de seguir.
1. **[Dueño] Respaldo Neon** de `production` (rama `respaldo-pre-deploy-AAAAMMDD`), mismo
   patrón que el checklist de arriba.
2. **[Agente] Push del lote acumulado + CI verde** (~10 min con Postgres del runner, D-202).
3. **[Agente] Migraciones a `production`:** `pnpm db:prod` (todas las pendientes salvo D-209,
   que exige el paso 5 antes — ver abajo). Verificar con
   `node scripts/migrations-status.mjs --branch production`.
4. **[Agente ejecuta, dueño aprueba] Limpia (D-208):**
   - `pnpm limpia:v4 --branch production` (dry-run) → el dueño revisa los conteos por tabla y el
     desglose de comprobantes.
   - `pnpm limpia:v4 --execute --branch production --confirm-production` una vez aprobado.
   - Purga cotizaciones, pedidos, OPs, reportes/staging, reservas, despachos, comprobantes,
     cobranzas/pagos, compras, bobinas y su kardex, movimientos e inventario de productos,
     clientes, proveedores, sesiones, auditoría, idempotencia, cambios de precio, caja/POS e
     importaciones (staging). Sobreviven líneas de negocio, catálogo (productos, BOM, materia
     prima), colores, acabados, usuarios y configuración; `exchange_rates`/`fiscal_series`
     quedan fuera de su alcance a propósito (correlativos y TC no son «datos de práctica»).
     Restaura el cliente «público en general» (D-077) y el proveedor «Saldo inicial de
     inventario» (D-206) vía `pnpm db:seed` al final — es parte del propio script, no un paso
     aparte.
5. **[Dueño, en la UI] Completar el catálogo de Acabados.** Prerrequisito de D-209:
   - Consolidar colores duplicados por criterio comercial (fusionar, p. ej., los rojos
     3002/3020 en «Rojo» si la lista de precios del cliente no los distingue — la distinción es
     comercial, no RAL).
   - Consolidar acabados duplicados y completar tipo/color/línea en los que falten.
6. **[Agente] Migración D-209 (obligatoriedad de acabados):** `pnpm db:prod` (ahora sí la aplica,
   ya con el catálogo completo). **Si falla** porque quedó algún acabado sin tipo, el error
   nombra los códigos exactos — no adivina nada — y hay que:
   1. Completar esos acabados en la UI (volver al paso 5).
   2. `pnpm exec prisma migrate resolve --rolled-back
20260915120000_d209_acabados_tipo_obligatorio` contra `production` (mismo patrón
      `DATABASE_URL`/`DIRECT_URL` por entorno, nunca por argv) antes de reintentar — Prisma deja
      la migración en estado fallido y no aplica ninguna otra hasta resolverla.
7. **[Agente ejecuta, dueño aprueba] Carga de inventario real (D-206/D-207):**
   - `pnpm import:initial-inventory --file <bobinas.xlsx> --branch production` (dry-run) → el
     dueño revisa el reporte fila por fila.
   - `pnpm import:initial-inventory --file <productos.xlsx> --kind products --branch production`
     (dry-run) → mismo revisión.
   - `--execute --confirm-production` en los dos, una vez aprobados. Ninguno actualiza una fila
     existente (D-206/D-207): un archivo con errores rechaza todo el archivo, nunca una carga
     parcial.
8. **[Agente] Deploy API** (`pnpm deploy:api`) **+ [dueño] verificación del web** + **[agente]
   `pnpm smoke:prod`** (solo lectura) + **[dueño] verificación final** en `/inventario`,
   `/bobinas` y `/acabados`.

### Lo que la ejecución real de V-4 (2026-09-15) corrigió de este checklist

El orden de arriba es el que se escribió en F8-V4prep; la ventana real encontró tres cosas que
el ensayo contra la rama clonada no podía ver. **Si este checklist se reutiliza, rige esto.**

1. **El código de D-209 no puede estar desplegado mientras quede un acabado sin tipo.** Esa es
   la causa real de que el paso 5 no se pudiera hacer desde la UI. El commit de D-209 quita el
   `?` de `Finish.kind`/`businessLineId` en `schema.prisma`, así que el cliente Prisma
   compilado con él **revienta al leer cualquier acabado con `kind` null** («Attempted to
   serialize non-enum-compatible value 'null' for enum 'FinishKind'»): el listado y la edición de
   Acabados caen, y también cualquier script que use ese cliente. El ensayo no lo vio porque
   completó los acabados con SQL y no con el código. Orden correcto para un cambio así: primero
   se completan los datos con código que todavía acepta el null, y recién después se despliega
   el código que lo prohíbe junto con su migración.
2. **El deploy del API va antes del paso 5, no en el 8.** Con las migraciones de D-203 ya
   aplicadas, el API anterior no conoce tipo/línea/color de un acabado: el web nuevo los
   muestra pero no se guardan. Por (1), el API que se despliega en ese punto **no puede traer
   todavía el schema de D-209**. En la ventana real el API se desplegó con D-209 incluido y
   los 8 acabados se completaron con un script de un solo uso: `FinishesService.update` dentro
   de un contexto de Nest, con un cliente Prisma aislado y generado sin la obligatoriedad (sin
   SQL y sin tocar `node_modules`). Funciona, pero es un rodeo que el orden correcto evita.
3. **El admin de producción no inicia sesión con el `ADMIN_PASSWORD` de `.env.setup`.** Es
   lo esperado y no una fuga: `.env.setup` está en `.gitignore` (nunca estuvo en el repo), y en
   producción ese valor es solo la **contraseña de arranque** que usa `prisma/seed.ts` para
   _crear_ el admin con `mustChangePassword = true`. El seed nunca pisa la contraseña de un admin
   que ya existe. **La credencial del admin de producción la gestiona el dueño, aparte.**
   Ningún paso de agente debe depender de ella: `smoke:prod` usa un admin efímero de E2E, y una
   escritura de catálogo sin UI va por un script que llama al servicio de dominio, nunca por un
   login con la contraseña de arranque.
