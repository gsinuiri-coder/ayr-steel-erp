# Handoff — Inventario inicial UPVC, preparación y dry-run (2026-09-22)

## 1. Resumen

Sesión corta de preparación para la segunda tanda de inventario inicial (D-206/D-207),
pendiente desde la ventana V-4. Se armó el archivo de productos UPVC y se corrió el dry-run
contra `demo`. **Bloqueada por un problema de catálogo, no se ejecutó nada.** Producción no se
tocó en ningún momento.

## 2. Hecho

- **PASO 1 — Verificación de catálogo (demo).** `UPVC36MT`, `UPVC6MT` y `UPVC36MTAZUL` existen,
  están activos y son de la línea `ROOFING` (Coberturas UPVC). Los tres tienen `source =
  MANUFACTURED`, no `PURCHASED`. Ninguno tiene `colorId` cargado, pese a que el nombre dice
  ROJO/ROJO/AZUL. Diagnóstico reusable: `scripts/oneoff/20260922-check-upvc-catalog.mjs --branch
  <rama>` (solo lectura).
- **PASO 2 — Archivo armado.** `local-data/inventario-inicial-upvc-2026-09-22.csv` (no versionado,
  `local-data/` está en `.gitignore`), 3 filas:

  | SKU | Unidades | Costo unitario (PEN, sin IGV) |
  | --- | --- | --- |
  | `UPVC36MT` | 970 | 43,2203 |
  | `UPVC6MT` | 1061 | 74,5763 |
  | `UPVC36MTAZUL` | 58 | 39,8300 |

  Total: **S/ 123.359,29 sin IGV** (cuadra con lo pedido). `FACTURA DE REFERENCIA` en las tres
  filas lleva la factura y el proveedor reales que pidió el dueño, como texto libre (D-206: no
  genera compra ni proveedor) — ese dato real queda solo en el archivo de `local-data/`, no en
  este handoff. `FECHA DE REFERENCIA` vacía (no se dio una fecha en el brief; el kardex quedará
  con «fecha de carga» si se ejecuta tal cual).
- **PASO 3 — Dry-run contra `demo`.** `pnpm import:initial-inventory --file
  local-data/inventario-inicial-upvc-2026-09-22.csv --kind products --branch demo`: **0 ok / 0
  omitida / 3 con error**, las tres por el mismo motivo: `SKU PRODUCTO "<sku>": es un producto
  fabricado (source MANUFACTURED), no de compra-reventa — fuera de alcance de esta herramienta.`
  El guard es exactamente el de D-207 (`source !== 'PURCHASED'`), no un falso positivo.
- **PASO 4 — no se ejecutó.** El dry-run no dio 3/3 OK, así que no hubo `--execute` contra
  `demo` ni contra ninguna otra rama, siguiendo la instrucción de detenerse ante un rechazo.
- **Trabajo de entorno necesario para poder correr el CLI**: `packages/shared/dist` y el Prisma
  Client locales estaban desactualizados (de antes del merge de RF-S3c/D-240/D-241, campo
  `seller_id`), y el `tsc -p tsconfig.cli.json` del importador no compilaba por eso (decenas de
  errores de tipos ajenos a este archivo). Se corrió `pnpm --filter @ayr/shared build` y `pnpm
  --filter @ayr/api db:generate` — solo regenera artefactos locales, no toca datos ni schema.

## 3. Decisiones tomadas

Ninguna. Esto es exactamente la ambigüedad de la regla dura 16: se presenta el hallazgo y se
espera la decisión del dueño, no se asume una corrección de catálogo por cuenta propia.

## 4. Bloqueos / pendientes

- **Bloqueo — `source` de catálogo.** Los tres SKU UPVC (`UPVC36MT`, `UPVC6MT`,
  `UPVC36MTAZUL`) están cargados como `MANUFACTURED` en `demo`, cuando UPVC es compra-reventa
  pura por definición (`AGENTS.md` §7, D-091, D-207). El importador de productos los rechaza por
  diseño (D-207: la pregunta de alcance la responde `source`, nunca el SKU ni la línea). Acción
  humana necesaria: decidir si se corrige el `source` de estos SKU a `PURCHASED` en el catálogo
  (¿en qué rama primero, y quién lo aprueba en `production`?), o si son los SKU equivocados y
  hay que usar otros para esta carga.
- **Observación aparte, no bloqueante para el importador**: ninguno de los tres tiene color
  cargado (`colorId` null) pese al nombre ROJO/ROJO/AZUL. `--kind products` no valida color (solo
  lo hace `--kind coils`, D-207), así que esto no impide el dry-run ni el execute — queda a
  criterio del dueño si vale la pena completarlo en Catálogo por prolijidad de reportes.
- **No verificado todavía**: si `production` tiene el mismo problema de `source` que `demo` (no
  se consultó producción en esta sesión, solo demo, según el alcance pedido).

## 5. Cómo verificar

```bash
# Reconfirmar el estado del catálogo en cualquier rama (solo lectura):
node scripts/oneoff/20260922-check-upvc-catalog.mjs --branch demo
node scripts/oneoff/20260922-check-upvc-catalog.mjs --branch production

# Una vez corregido el catálogo, repetir el dry-run (no escribe nada):
pnpm import:initial-inventory --file local-data/inventario-inicial-upvc-2026-09-22.csv \
  --kind products --branch demo

# Si el dry-run da 3/3 OK, recién ahí ejecutar contra demo:
pnpm import:initial-inventory --file local-data/inventario-inicial-upvc-2026-09-22.csv \
  --kind products --branch demo --execute
```

Resultado esperado del dry-run limpio: `3 fila(s): 3 ok, 0 omitida(s), 0 con error.`

## 6. Siguiente sesión

Con la decisión del dueño sobre el `source` de los tres SKU (y, si corresponde, el color):
1. Corregir el catálogo en la rama que el dueño indique.
2. Repetir el dry-run de PASO 3 hasta que dé 3/3 OK.
3. `--execute` contra `demo`, verificar kardex valorizado (3 saldos, S/ 123.359,29) y el total.
4. Recién con eso probado, repetir contra `production` con `--confirm-production`, en la ventana
   que el dueño autorice — no en esta sesión.

No se toca el archivo `local-data/inventario-inicial-upvc-2026-09-22.csv` salvo que cambien los
montos o los SKU: ya está listo tal como lo pidió el dueño.
