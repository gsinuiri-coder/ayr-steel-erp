# Handoff — Inventario inicial UPVC, preparación y carga en demo (2026-09-22)

## 1. Resumen

Segunda tanda de inventario inicial (D-206/D-207), pendiente desde la ventana V-4. Archivo
armado, catálogo corregido y **carga ejecutada y verificada contra `demo`**. Producción no se
tocó en esta sesión — el dueño ya había corregido el `source` de los tres SKU ahí, aparte.

## 2. Hecho

- **PASO 1 — Verificación de catálogo.** `UPVC36MT`, `UPVC6MT` y `UPVC36MTAZUL` existían,
  activos, línea `ROOFING` (Coberturas UPVC), pero con `source = MANUFACTURED` en `demo` (el
  dueño ya lo había corregido en `production`). Diagnóstico reusable: `node
  scripts/oneoff/20260922-check-upvc-catalog.mjs --branch <rama>` (solo lectura).
- **Corrección de catálogo en `demo`.** Con el OK del dueño, se corrigió `source` de los tres
  SKU a `PURCHASED` vía `CatalogService.update` (el mismo servicio que usa `PATCH
  /catalog/:id`, D-131) — nunca SQL directo. Queda auditado en `audit_log` (`catalog.update`,
  actor = el `ADMINISTRADOR` de `.env.setup`). El script one-off que hizo el cambio
  (`oneoff-fix-upvc-source.ts`) y su entrada temporal en `tsconfig.cli.json` ya se borraron —
  era una mutación puntual, no una herramienta para dejar viva.
- **PASO 2 — Archivo armado.** `local-data/inventario-inicial-upvc-2026-09-22.csv` (no
  versionado, `local-data/` está en `.gitignore`), 3 filas:

  | SKU | Unidades | Costo unitario (PEN, sin IGV) |
  | --- | --- | --- |
  | `UPVC36MT` | 970 | 43,2203 |
  | `UPVC6MT` | 1061 | 74,5763 |
  | `UPVC36MTAZUL` | 58 | 39,8300 |

  `FACTURA DE REFERENCIA` en las tres filas lleva la factura y el proveedor reales que pidió el
  dueño, como texto libre (D-206: no genera compra ni proveedor) — ese dato real queda solo en
  el archivo de `local-data/`, no en este handoff. `FECHA DE REFERENCIA` vacía (el kardex quedó
  con «fecha de carga»).
- **PASO 3 — Dry-run contra `demo`, tras la corrección**: `3 fila(s): 3 ok, 0 omitida(s), 0 con
  error.`
- **PASO 4 — Execute contra `demo`**: `3 línea(s) de producto creada(s)`, sin filas omitidas ni
  con error. Verificado con `node scripts/oneoff/20260922-verify-upvc-balances.mjs --branch
  demo` (solo lectura, se deja para reusar):

  | SKU | Saldo | `avgCost` | Movimientos | Valorizado |
  | --- | --- | --- | --- | --- |
  | `UPVC36MT` | 970,000 | 43,2203 | 1 (`IMPORT`) | S/ 41.923,69 |
  | `UPVC6MT` | 1.061,000 | 74,5763 | 1 (`IMPORT`) | S/ 79.125,45 |
  | `UPVC36MTAZUL` | 58,000 | 39,8300 | 1 (`IMPORT`) | S/ 2.310,14 |

  **TOTAL valorizado: S/ 123.359,29 sin IGV** — cuadra exacto con lo pedido.
- **Trabajo de entorno necesario para poder compilar el CLI**: `packages/shared/dist` y el
  Prisma Client locales estaban desactualizados (de antes del merge de RF-S3c/D-240/D-241,
  campo `seller_id`). Se corrió `pnpm --filter @ayr/shared build` y `pnpm --filter @ayr/api
  db:generate` — solo regenera artefactos locales, no toca datos ni schema.

## 3. Decisiones tomadas

Ninguna nueva D-nnn. La corrección de `source` en `demo` fue una corrección de dato de catálogo
con OK explícito del dueño en la sesión (ya aplicada por él mismo en `production`), no una
decisión de diseño nueva.

## 4. Bloqueos / pendientes

- **Color no cargado, no bloqueante.** Ninguno de los tres SKU tiene `colorId` pese al nombre
  ROJO/ROJO/AZUL. `--kind products` no valida color (solo `--kind coils`, D-207), así que no
  bloqueó nada — queda a criterio del dueño si vale la pena completarlo en Catálogo por
  prolijidad de reportes/filtros.
- **Producción**: el dueño ya corrigió `source` ahí; falta correr la carga real. No se hizo en
  esta sesión — es alcance de la ventana de producción, con `--confirm-production` y
  aprobación explícita (D-234).

## 5. Cómo verificar

```bash
# Catálogo (solo lectura, cualquier rama):
node scripts/oneoff/20260922-check-upvc-catalog.mjs --branch demo

# Saldo e inventario valorizado (solo lectura, cualquier rama):
node scripts/oneoff/20260922-verify-upvc-balances.mjs --branch demo

# Dry-run (no escribe nada):
pnpm import:initial-inventory --file local-data/inventario-inicial-upvc-2026-09-22.csv \
  --kind products --branch demo
```

Resultado esperado: los tres SKU en `PURCHASED`, dry-run `3 ok, 0 omitida(s), 0 con error`, y
`verify-upvc-balances` mostrando los tres saldos y el total S/ 123.359,29.

## 6. Siguiente sesión

1. Confirmar que `production` tiene los tres SKU en `PURCHASED` (el dueño dice que sí; no se
   verificó en esta sesión porque leer producción quedó fuera del alcance pedido).
2. Dry-run contra `production` con el mismo archivo
   (`local-data/inventario-inicial-upvc-2026-09-22.csv`).
3. Si sale 3/3 OK, `--execute --branch production --confirm-production`, en la ventana que el
   dueño autorice — no encadenar automáticamente desde esta sesión.
4. Verificar kardex valorizado y total en `production` con el mismo criterio que acá (o
   `pnpm smoke:prod`, que ya lee inventario valorizado).

No se toca el archivo `local-data/inventario-inicial-upvc-2026-09-22.csv`: es el mismo que se
va a usar contra `production`.
