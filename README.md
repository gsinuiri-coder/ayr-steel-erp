# AYR Steel ERP

ERP web para una empresa peruana de transformación y venta de acero. Documentación completa en
`docs/` (arquitectura, decisiones, entornos, progreso); reglas del agente en `CLAUDE.md`.

## Entorno local (Docker)

Un Postgres 100% local, sin cuenta de Neon: sirve para desarrollar sin red y para correr la
suite E2E rápido y aislada. Detalle completo en [`docs/ENTORNOS.md`](docs/ENTORNOS.md#local-docker--no-es-neon).

### Levantar

```
pnpm install
pnpm dev:local     # Postgres (docker compose) + migrate + seed + api :3000 + web :3001
```

Admin por defecto: `admin@ayr.local` / `AyrLocal-2026!` (ver `scripts/local-docker-env.mjs`).

### Resetear

```
pnpm db:local reset
```

Borra el volumen de Docker entero y vuelve a aplicar migraciones + seed. Pierde todo lo que
haya solo en la base local (es descartable, a propósito).

### Snapshot / restore

```
pnpm db:local snapshot antes-de-probar-algo
pnpm db:local restore antes-de-probar-algo
```

El volcado va a `local-data/db-local-snapshots/` (fuera del repo, ver `.gitignore`).

### E2E

```
pnpm e2e
```

Por defecto corre contra una segunda base del mismo Postgres local (`ayr_local_e2e`, separada
de la que usa `pnpm dev:local`) y la vacía en cada corrida. En CI corre contra Neon rama `ci`;
nunca contra producción (D-126).
