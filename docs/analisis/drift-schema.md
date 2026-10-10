# Drift de schema: clasificación (cc42, 2026-10-10)

Qué había: desde la ventana S2 (D-211) cada `migrate diff` contra `production` mostraba el mismo
«drift conocido» de 13 diferencias, y cada ventana comprobaba que siguiera igual, sin saber de
dónde venía. Esta nota lo clasifica, corrige lo que se puede corregir sin migración y deja un
guardián en la CI (D-593).

## Método (solo lectura)

1. `node scripts/migrations-diff.mjs --branch production --script`: SQL de `prisma migrate diff`
   de la base real a `schema.prisma`, con la credencial por el entorno del hijo.
2. `pnpm check:drift --write` sobre una base **vacía** del Docker local (`ayr_drift_check`) a la
   que `migrate deploy` le aplicó las 82 migraciones: el mismo SQL, pero de lo que las migraciones
   crean.
3. Comparación de los dos SQL, texto contra texto. Si difieren, la diferencia es REAL: algo en
   `production` que las migraciones no crean.

**Resultado:** el SQL de `production` y el de la base desde cero eran **idénticos** (36 líneas,
las 13 diferencias). Ninguna diferencia es REAL: todo lo que tiene `production` lo crean las
migraciones, y es `schema.prisma` el que no lo declaraba. Después de la corrección, los dos siguen
idénticos (5 sentencias).

Límite del método: `prisma migrate diff` no ve CHECK, triggers, funciones ni extensiones. Esos
objetos no entran en esta comparación (ver «Lo que no cubre»).

## Clasificación

| #   | Diferencia                                                                                                                                                              | Clase                        | Origen                                                                                                                                                         | Qué se hizo                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–5 | `DEFAULT (now() AT TIME ZONE 'America/Lima')::date` en `operation_date` de `coils`, `cutting_orders`, `inventory_movements`, `production_orders` y `production_reports` | ESPERADA (deliberada, D-594) | Migración `20260906140000_fase7_operation_date_default` (D-124): cubre a la revisión vieja del API que inserta sin conocer la columna mientras dura un deploy. | Se deja fuera de `schema.prisma` a propósito y queda en la lista aprobada. Declararla con `@default(dbgenerated(…))` volvería opcional `operationDate` en los `create` del cliente: un escritor nuevo que la olvidara compilaría y tomaría la fecha de la base, sin pasar por `OperationDateService`. |
| 6   | FK `dispatches.invoice_id` → `fiscal_documents`                                                                                                                         | SOLO-SCHEMA                  | `20260915090000_d205_invoice_id_en_kardex` la crea `ON DELETE RESTRICT`; el schema no decía nada y Prisma asume `SET NULL` en una relación opcional.           | `onDelete: Restrict` en `Dispatch.invoice`.                                                                                                                                                                                                                                                           |
| 7   | FK `finishes.color_id` → `colors`                                                                                                                                       | SOLO-SCHEMA                  | `20260914120000_d203_acabado_tipo_color_linea`, `RESTRICT`.                                                                                                    | `onDelete: Restrict` en `Finish.color`.                                                                                                                                                                                                                                                               |
| 8   | FK `production_orders.bom_id` → `product_boms`                                                                                                                          | SOLO-SCHEMA                  | `20260904140000_fase4_produccion_drywall`, `RESTRICT`.                                                                                                         | `onDelete: Restrict` en `ProductionOrder.bom`.                                                                                                                                                                                                                                                        |
| 9   | FK `products.finish_id` → `finishes`                                                                                                                                    | SOLO-SCHEMA                  | `20260907160000_fase7final_d122_acabado_en_el_producto`, `RESTRICT`.                                                                                           | `onDelete: Restrict` en `Product.finish`.                                                                                                                                                                                                                                                             |
| 10  | FK `raw_material_specs.color_id` → `colors`                                                                                                                             | SOLO-SCHEMA                  | `20260907120100_fase7final_reserva_generica_de_mp`, `RESTRICT`.                                                                                                | `onDelete: Restrict` en `RawMaterialSpec.color`.                                                                                                                                                                                                                                                      |
| 11  | Índice `products_finish_id_idx`                                                                                                                                         | SOLO-SCHEMA                  | `20260907160000_fase7final_d122_acabado_en_el_producto`.                                                                                                       | `@@index([finishId])` en `Product` (mismo nombre por defecto).                                                                                                                                                                                                                                        |
| 12  | Índice `sales_orders_origin_status_idx`                                                                                                                                 | SOLO-SCHEMA                  | `20260907180000_fase7finalb_origen_del_pedido`.                                                                                                                | `@@index([origin, status])` en `SalesOrder`.                                                                                                                                                                                                                                                          |
| 13  | Índice `raw_material_specs_lookup_idx` (Prisma quería renombrarlo)                                                                                                      | SOLO-SCHEMA                  | `20260907120100_fase7final_reserva_generica_de_mp` lo creó con nombre propio.                                                                                  | `map: "raw_material_specs_lookup_idx"` en el `@@index` de `RawMaterialSpec`.                                                                                                                                                                                                                          |

REAL: ninguna.

En las FK, la base tenía razón: `RESTRICT` es lo que se quiere (no se borra un acabado que usa un
producto, ni un comprobante que un despacho declara). Si alguien hubiera generado una migración con
`migrate dev` sobre el schema viejo, Prisma las habría pasado a `SET NULL` sin que nadie lo pidiera.

## El cliente generado no cambia de comportamiento

Comparado antes y después de `prisma generate`:

- `index.d.ts` (los tipos del cliente) es **idéntico** byte a byte;
- `index.js` cambia solo en el schema embebido, su hash y `relationOnDelete: "Restrict"` en el
  modelo de datos de las cinco relaciones. Con `relationMode` por defecto (`foreignKeys`), Prisma
  no emula acciones referenciales: el borrado lo decide la FK de la base, que ya era `RESTRICT`.
  Los índices no llegan al cliente.

Como `schema.prisma` vive en `apps/`, el cambio cuenta como runtime para la regla del `git-sha`
(AGENTS.md §3.2) y la API se despliega igual, sin migración.

## Guardián en la CI (D-593)

`pnpm check:drift` (`scripts/check-drift.mjs`) crea la base vacía `ayr_drift_check` en un Postgres
**local** (Docker en la máquina; en GitHub Actions, el Postgres de servicio del job E2E), le aplica
las migraciones, saca el SQL de `migrate diff` y lo compara sentencia por sentencia con
`apps/api/prisma/drift-esperado.sql`. Falla si aparece una diferencia que no está aprobada (por
ejemplo, un cambio de `schema.prisma` sin su migración) o si desaparece una que sí estaba. Rechaza
cualquier host que no sea `localhost`/`127.0.0.1` y borra la base al terminar.

Para aprobar una diferencia nueva de las que Prisma no puede expresar: clasificarla aquí, con su
D-nnn, y reescribir la lista con `pnpm check:drift --write`.

El guardián compara una base **desde cero**. Que `production` siga igual a esa base lo comprueba
cada ventana con `node scripts/migrations-diff.mjs --branch production --script`, cuyo SQL debe
ser exactamente el de `drift-esperado.sql` (sin las notas `-- #`).

## Lo que no cubre

- **CHECK, triggers, funciones y extensiones.** `migrate diff` no los ve, así que ni esta
  comparación ni el guardián dicen si `production` los tiene todos. Compararlos exige leer el
  catálogo de Postgres de `production` (SQL directo, prohibido) o un `pg_dump --schema-only` de una
  rama hija. Queda como propuesta, no se hizo.
- **`demo`** está detrás: le falta la migración de cc41 (`production_report_drafts.meters` y
  `pieces_count`). No es drift: se aplica cuando se restablezca demo.
