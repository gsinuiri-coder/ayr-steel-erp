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

## ci

La corrida completa de Playwright (`pnpm e2e`) vive acá y en local, nunca contra producción.
La rama se resetea por corrida, así que el residuo que la suite deja no le importa a nadie.

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
