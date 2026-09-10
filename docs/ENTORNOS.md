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

Storage tipo R2 (los adjuntos de `imports`) es opcional: `docker compose --profile storage up
-d` levanta MinIO y `apps/api/.env` (o el entorno que uses) apunta `R2_ENDPOINT` a
`http://localhost:9000` con las credenciales de `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. Sin
esto, `StorageService` responde 503 — degradación ya prevista, no un fallo de arranque.

## ci

La corrida completa de Playwright en GitHub Actions (`pnpm e2e`, con `CI=true`) vive contra la
rama Neon `ci`, que se resetea por corrida — el residuo que la suite deja no le importa a
nadie. **En local, `pnpm e2e` ya no toca Neon**: corre contra el Postgres de Docker de arriba
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
  exactamente el complemento. **Antes hay que vaciar los comprobantes de la cuenta demo** en el
  panel de Nubefact.
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
- **La suite completa: local y CI**, contra `ci`. Es la que manda antes de un push (D-123).
- **`pnpm prod:purge-e2e` queda solo para emergencias documentadas**: si algún día vuelve a
  entrar residuo E2E a producción, se usa una vez y se anota en `PROGRESO.md` por qué.

La regla no vive solo acá: `scripts/e2e-prod.mjs` **se niega a correr** salvo que se le pase
`AYR_ALLOW_E2E_PROD=1`, y el mensaje que muestra remite a `pnpm smoke:prod`. Una prohibición que
solo existe en un documento se saltea tecleando el comando de siempre.
