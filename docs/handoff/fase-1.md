# Handoff — Fase 1 (Maestros, catálogo, precios, tipo de cambio, importación) — 2026-09-02

## 1. Resumen

Fase 1 según `docs/ARQUITECTURA.md` §3.7 (D-034): **cerrada**. Se entregaron líneas de negocio (solo lectura), acabados, catálogo por línea, clientes, proveedores, márgenes de precio, tipo de cambio (apis.net.pe con fallback manual) y un módulo genérico de importación masiva desde planilla (adaptadores para productos y clientes).
Estado: `pnpm turbo lint typecheck test` en verde; 35 unit + 12 E2E (Fase 0 + Fase 1) en verde local; CI en `main` verde en las dos últimas corridas (33682260101 y 33682674374). Migración aplicada y seed corrido en Neon `production`; API redesplegado en Cloud Run; `pnpm e2e:prod` (6/6) verde tras el deploy.
Revisado por `revisor` y `auditor-seguridad`: se corrigieron los hallazgos altos (baja lógica ausente en la UI, `xlsx` con CVEs) y varios medios/bajos; quedan dos hallazgos bajos diferidos a Fase 7 (documentados abajo).

## 2. Hecho

1. **Decisiones y requisitos** — `docs/ARQUITECTURA.md` §0.2 (D-025..D-034, renumeradas desde D-024 por colisión con el cierre de Fase 0), §5 (P-02..P-10 resueltas), §3.7 (fases reordenadas), §4.7/§4.8 nuevas (RF-80..94). Contexto largo de las decisiones que cambiaron de opinión respecto a la recomendación original (P-04, P-06, P-07, P-09) en `docs/DECISIONES.md`.
2. **Prisma** — `apps/api/prisma/schema.prisma`: tabla `business_lines` (reemplaza el enum suelto de Fase 0), `finishes`, `products`, `customers`, `suppliers`, `pricing_settings`, `exchange_rates`, `import_batches`, `import_rows`. Migración `20260902195110_fase1_maestros_catalogo_importacion`, aplicada en `dev`, `ci` (vía CI) y `production` (`pnpm db:prod`). Seed (`apps/api/prisma/seed.ts`) crea las 5 líneas y su margen inicial (20 %/10 %).
3. **`@ayr/shared`** — enums (`InventoryStrategy`, `Currency`, `ExchangeRateSource`, `ProductSource`, `DocType`, `ImportEntity`/`ImportRowStatus`/`ImportBatchStatus`) y schemas Zod nuevos en `packages/shared/src/schemas/{business-line,finish,product,customer,supplier,pricing,exchange-rate,import}.ts`. `decimal.ts` gana la escala `RATE` (4) y `decimalStringSchema()` para validar Decimal-como-string genéricamente.
4. **API** — módulos `business-lines` (solo lectura), `finishes`, `catalog`, `customers`, `suppliers`, `pricing`, `exchange-rates`, `documents` (R2), `imports` (genérico + adaptadores `products`/`customers`) en `apps/api/src/*`. Todas las mutaciones van con `@Roles(Role.ADMINISTRADOR)` y auditoría en la misma transacción; lectura abierta a cualquier rol autenticado.
5. **Importación (RF-52)** — `apps/api/src/imports/`: sube el archivo a R2, lo parsea (xlsx o csv, tolerante a tildes/mayúsculas en encabezados), valida fila por fila contra el adaptador de la entidad, detecta duplicados dentro del propio archivo, permite editar filas inválidas y confirma solo las válidas (cada una en su propia transacción).
6. **Web** — `/lineas`, `/acabados`, `/catalogo` (tabs por línea + importar), `/clientes`, `/proveedores` (con `providesCuttingService`), `/configuracion/margenes`, `/configuracion/tipo-cambio`. Todas con baja lógica (Activar/Desactivar) y búsqueda por nombre/documento donde aplica (RF-84). `components/imports/import-dialog.tsx` es el importador genérico reutilizado por catálogo y clientes.
7. **Tests** — `apps/api/src/{pricing,exchange-rates}/*.spec.ts` (fórmula de precio sugerido, margen mínimo, caché/fallback de TC). `e2e/tests/fase1.spec.ts`: crear acabado, crear producto, importar con fila mala → corregir → confirmar, cambiar margen como admin, vendedor sin acceso a `/configuracion`.
8. **Seguridad** — revisor y auditor-seguridad corrieron sobre el diff completo; hallazgos corregidos: baja lógica ausente en 4 vistas, `xlsx@0.18.5` (2 CVE high) reemplazado por el build oficial `0.20.3` de `cdn.sheetjs.com`, nombre de archivo saneado antes de ir a R2/DB, mensajes de error de Prisma ya no se filtran crudos al preview de importación.
9. **Deploy** — `pnpm db:prod`, `pnpm secrets:gcp`, `pnpm secrets:gh`, `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`; web redesplegado automáticamente por el push a `main` (proyecto Vercel ligado al repo). `pnpm e2e:prod` verde tras el deploy.

## 3. Decisiones tomadas

- D-025 — Emisión de comprobantes directo a SUNAT vía Nubefact desde la venta; RF-71 (importación) solo para histórico/contingencia.
- D-026 — Cotización confirmada genera `production_orders` separada, no la cotización misma es la orden.
- D-027 — Venta directa de bobina genera SKU `BOB-{finishCode}-{thicknessMm}-{widthMm}` en línea `trading` (decisión final distinta a la recomendación original de P-04, que era vender sin SKU).
- D-028 — Valorización de kardex por promedio ponderado (por producto y por línea).
- D-029 — TC SUNAT vía apis.net.pe con caché en `exchange_rates` y fallback al último valor conocido; PEN es 1:1 sin consulta.
- D-030 — Módulo de compras completo (proveedor → compra tipada → recepción → cuenta por pagar → pagos), a construir en Fase 2.
- D-031 — §4.7 = clientes/proveedores (RF-80..89), §4.8 = reportes (RF-90..94).
- D-032 — Precio sugerido = costo promedio × (1 + margen%); margen y margen mínimo por línea en `pricing_settings`, editables solo por ADMINISTRADOR.
- D-033 — Varios proveedores de corte tercerizado; costo por kg se ingresa al recibir, no antes.
- D-034 — Fases reordenadas: F1 = maestros + importación (esta fase), F2 = compras + bobinas + kardex.

Nota de numeración: estas decisiones se registraron como D-025..D-034 (no D-024..D-033 como decía el prompt de arranque) porque D-024 ya estaba tomado por el cierre de Fase 0. Detalle en `docs/DECISIONES.md`.

## 4. Bloqueos / pendientes

Ninguno abierto que requiera al dueño. Diferido a Fase 7 (hardening), riesgo bajo porque `imports` es ADMINISTRADOR-only:

- `parse-spreadsheet.ts` aplica el límite de 2000 filas después de que SheetJS ya descomprimió el archivo en memoria; falta acotar el tamaño descomprimido o mover el parseo a un worker.
- El `ContentType` guardado en R2 para el archivo de import es el que declara el cliente, no uno derivado del contenido; no es explotable hoy porque no hay endpoint que sirva ese objeto de vuelta.
- El bucket R2 de CI es el mismo que el de producción; quedan objetos de prueba con prefijo `imports/...` tras cada corrida de CI.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test              # exit 0 (35 unit)
pnpm e2e                                    # 12 E2E locales contra Neon dev
pnpm e2e:prod                               # 6 escenarios de auth contra producción (D-024)
gh run list --limit 3                       # CI en main
pnpm audit --prod --audit-level=high        # sin vulnerabilidades
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
curl -s https://ayr-steel-erp-web.vercel.app/api/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con la migración de Fase 1 y las 5 líneas + márgenes sembrados.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla primero con `pnpm db:prod`.

## 6. Siguiente sesión

Fase 2 (§3.7, D-034): compras (D-030) + bobinas completas (RF-10..RF-23) + kardex.

Primera tarea concreta: numerar los RF de compras (no se numeraron en esta fase, solo se registró la decisión D-030) y modelar en `schema.prisma` las entidades `suppliers`→ya existe, falta `purchases` (tipada COIL|FINISHED_GOOD|SERVICE|EXPENSE), `purchase_receipts`, `accounts_payable`, `payments`, además de `coils` (bobinas) e `inventory_movements` (kardex, §3.2 — regla dura: ningún módulo escribe stock directamente, todo pasa por `inventory`). Recordar que la venta directa de bobina (D-027) necesita que el `catalog` sepa generar el SKU `BOB-{finishCode}-{thicknessMm}-{widthMm}` automáticamente al crear una bobina, no a mano.
