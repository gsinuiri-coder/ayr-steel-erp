# Ventana cc42 — Drift de schema, `seed:escenarios` y ratificación de D-591

2026-10-10, sesión atendida (el dueño presente). Ventana suspendida (D-533). Sin migraciones, sin
SQL contra producción y sin escrituras de datos en producción. D-591 ratificada por el dueño.

## Estado en producción

| Qué                 | Valor                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| PR #169 y CI        | CI completa en verde (E2E 31 min con `check:drift`, `escenarios` 1 min 37 s, smoke Neon, Sonar) |
| API en Cloud Run    | `ayr-steel-erp-api-00114-mgd`, `git-sha=dfbc6bff`, 100 % del tráfico                            |
| Web en Vercel       | `main` `dfbc6bff` (sin cambios de web)                                                          |
| Smoke de producción | Verde después del deploy de la API                                                              |
| Drift de producción | `migrations-diff.mjs --branch production --script` = `drift-esperado.sql` exacto (5 defaults)   |

El deploy de la API fue sin migración: `schema.prisma` cambió solo en declaraciones (FK, índices,
nombre de índice) y vive en `apps/`, así que cuenta para la regla del `git-sha` (AGENTS.md §3.2).
**Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions
ayr-steel-erp-api-00113-d6r=100` (`git-sha=8e84d734`); no hace falta revertir nada más.

## Drift de schema (D-593, D-594)

| Clase       | Diferencia                                                     | Qué se hizo                                                    |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| ESPERADA    | 5 defaults de `operation_date` (D-124)                         | Fuera del schema a propósito (D-594); en `drift-esperado.sql`. |
| SOLO-SCHEMA | 5 FK `ON DELETE RESTRICT` que el schema dejaba en `SET NULL`   | `onDelete: Restrict` en `schema.prisma`.                       |
| SOLO-SCHEMA | Índices `products(finish_id)` y `sales_orders(origin, status)` | `@@index` en `Product` y `SalesOrder`.                         |
| SOLO-SCHEMA | `raw_material_specs_lookup_idx` (Prisma quería renombrarlo)    | `map:` en el `@@index`.                                        |
| REAL        | Ninguna en `production` (mismo SQL que la base desde cero)     | —                                                              |

Clasificación completa: `docs/analisis/drift-schema.md`. Guardián: `pnpm check:drift` en el job
`e2e` (base `ayr_drift_check` desde cero contra `apps/api/prisma/drift-esperado.sql`).

**Drift REAL en el `ayr_local` del dueño (no en producción).** Tenía aplicadas dos migraciones de
una rama abandonada de D-248 (`20260922150000_d248_accesorio_enum` y
`20260922150100_d248_accesorios_de_cobertura`, nunca commiteadas): la columna
`products.development_mm` y un CHECK que la exige en todo accesorio, por lo que el alta del
accesorio daba 500. Con el OK del dueño se quitaron solo esos restos, en una transacción sobre
el Docker local: `DROP CONSTRAINT products_development_mm_check`, `DROP COLUMN development_mm`
(2 productos viejos tenían un valor, que la app no usa) y las 2 filas de `_prisma_migrations`.
`migrate diff` de `ayr_local` quedó igual a la lista aprobada, con 82 migraciones.

## `seed:escenarios` (D-592, D-595)

Corrido en el `ayr_local` del dueño; `pnpm dev:preview` quedó arriba (api :4000, web :4001,
lanzado desde el checkout principal, log en `local-data/dev-preview-cc42.log`). Entrar con
`viewer@ayr.local`.

| Caso    | Pedido     | OP        | Abrir                                                                | Qué probar                                                                                  |
| ------- | ---------- | --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P1      | PED-000002 | OP-000002 | http://127.0.0.1:4001/planta?op=c353a40f-2fc3-456e-b0ee-61a9713edcf0 | 1 y 2 rinden de más y se terminan; la 3 llena sola sin confirmar; cerrar pide «Confirmo…»   |
| P2      | PED-000003 | OP-000003 | http://127.0.0.1:4001/planta?op=0811c0b1-8255-41f8-b13a-5dbb5cf8faef | barra en tres tramos; 1 plancha más → «Excede el plan» (D-574); cerrar con el plan completo |
| M1      | PED-000004 | OP-000004 | http://127.0.0.1:4001/planta?op=97285c95-ec78-404f-82b9-dea412f6319a | bobina 2 con 2,50 × 10 → casilla del 1 %; bobina 3 con 230 kg → despunte > 10 % pide motivo |
| M2      | PED-000005 | OP-000005 | http://127.0.0.1:4001/planta?op=020bdc9d-ad11-4003-bb0e-6325be28c798 | bloque 4 llenado solo sin confirmar; «Registrar producción» manda solo el borrador          |
| A1      | PED-000006 | OP-000006 | http://127.0.0.1:4001/planta?op=f5d31620-0d3a-4db1-bba0-16836ca5f6bc | 20 m en el borrador del servidor (D-591); bobina 2: 20 m; la 3 llena sola                   |
| A2      | PED-000007 | OP-000007 | http://127.0.0.1:4001/planta?op=be20e7a7-a73b-42a1-8c41-2c569737d23e | 4 m en la bobina 2 → «Excede el plan en 1.000 m»; con 3 m cierra exacto                     |
| Drywall | —          | —         | http://127.0.0.1:4001/corte/2994d6e6-ff07-43c9-acb0-28966efb551c     | 5 flejes de 244 mm del parante; la otra bobina libre para tu corte; perfiles en /planta     |

**Lo que apareció al correrlo de verdad**, ya corregido en el PR de cierre:

- desde un worktree, `docker compose up` choca con el contenedor `ayr-local-db` de nombre fijo:
  ahora, si está corriendo, no se toca;
- un checkout con el cliente Prisma viejo compila mal la API: ahora corre `prisma generate`. En
  Windows el DLL del motor puede estar tomado (la demo de cc38 corre desde el checkout principal
  en 3100/3101); el `generate` falla al final pero ya escribió el cliente, y el motor es el mismo.

## Revisión

Autorrevisión (subagente sin el contexto de implementación) y segundo modelo (Sonnet, contexto
limpio, `docs/revision/cc42-segundo-modelo.md`): 0 P0. P1: el guard aceptaba `?host=`/`?dbname=`
en la URL; ahora solo admite `schema=public` y rearma la URL. P2 corregidos y los que se dejaron,
con motivo, en la respuesta del autor del mismo informe.

## Lo que quedó afuera

- CHECK, triggers y funciones de `production`: `migrate diff` no los ve; compararlos exige leer el
  catálogo de `production` o un `pg_dump --schema-only` de una rama hija. No se hizo.
- `demo` sigue sin la migración de cc41; la demo de cc38 corre desde el checkout principal en
  3100/3101 con código anterior. Con `seed:escenarios` la demo deja de ser necesaria para planta;
  apagarla o restablecerla es decisión del dueño.
- `seed:escenarios` no se probó con comprobantes, cobros ni despachos del cliente demo (en local
  el PSE está apagado); esos caminos de anulación son los de `prod:purge-e2e` y, si fallan, salen
  en el informe sin cortar la siembra.
- D-592..D-595 pendientes de ratificación.
