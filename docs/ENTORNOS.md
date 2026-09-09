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
