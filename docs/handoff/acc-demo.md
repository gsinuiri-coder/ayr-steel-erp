# Handoff — ACC-demo (2026-09-22)

## 1. Resumen

Accesorios de cobertura (D-248) para **validar con el cliente**: SKU con desarrollo, OP que se
reporta en pasadas, producción a stock y datos de demo. Rama `acc-demo` desde `7a2c1c3`, PR en
**draft**; **no se mergea** hasta que el cliente valide. Producción intacta. Verificación local
verde (707 unitarios, 53 suites) y flujo probado contra la app corriendo; la suite E2E completa
la juzga la CI del PR.

## 2. Hecho

- **M1 — SKU de accesorio.** `ACCESORIO` como tercer `roofingKind` + `products.development_mm`,
  en **dos** migraciones aditivas (`20260922150000_d248_accesorio_enum` y
  `20260922150100_d248_accesorios_de_cobertura`). La primera solo agrega el valor al enum: PG no
  deja usarlo en la misma transacción que lo crea, y el `CHECK` de la segunda lo nombra.
  `products_roofing_kind_unit_check` se extendió (era lista blanca) y se sumó
  `products_development_mm_check`. Predicado `isAccessory` en `apps/api/src/sales/sales-lines.ts`
  con su fila en el centinela `sales-lines.spec.ts`.
- **M2 — OP y reporte por pasadas.** `accessoryConversion` / `accessoryPiecesFromPasses` /
  `accessoryYieldWarning` en `apps/api/src/production/roofing-math.ts`; se aplican en
  `reportInTx`, en la validación del borrador (`roofing-drafts.ts`), en el selector de bobinas y
  en la pestaña de planta. Aritmética compartida en `packages/shared/src/schemas/production.ts`
  (`accessoryPiecesPerPass`, `accessoryEffectiveWidthMm`, `accessoryEdgeScrap`).
- **M3 — A stock.** `createToStock` vuelve a tener llamador, **solo** para `ACCESORIO`; la
  corrida elige el largo (`pieceLengthMm`) con la cota de D-166. Tarjeta «Accesorios a stock» en
  `/planta`.
- **M4 — Datos de demo.** `scripts/oneoff/20260922-demo-accesorios.mjs` (HTTP, nunca SQL) y guion
  en `docs/uat/acc-demo.md`.

Commits, en orden: `6d74f3b` (M1) · `c1852af` (M2) · `d95316d` (E2E + guion de datos) ·
`307e11a` (M3) · `fe34dcb` (dos defectos de pantalla) · el de documentación de cierre.

## 3. Decisiones tomadas

- **D-248** — la decisión completa está en `docs/ARQUITECTURA.md` §0.2. En corto: ancho efectivo
  `ancho ÷ N` en toda la aritmética de material; `N` sale del **rollo montado**, no del catálogo;
  se tipean pasadas y se persisten piezas; el canto es merma derivada que se muestra y no emite
  kardex; a stock sí, y ahí la corrida elige el largo.

Las cuatro sub-decisiones (a/b/c/d) y los tres ajustes del brief los aprobó el dueño en sesión
antes de escribir código.

## 4. Bloqueos / pendientes

- **Pendiente de decisión del cliente**, anotado en el guion: ¿un pedido de accesorio debe tomar
  el stock que ya existe, o producir siempre? Hoy **produce siempre** (`isMadeToOrder` es true),
  así que el saldo a stock solo se vende por mostrador. Es exactamente la pregunta que D-171 dejó
  abierta para las planchas y que ahora tiene caso real. Si la respuesta es «que lo tome», hay
  que decidir también el caso parcial (alcanza para parte del pedido).
- **La migración contra Neon `demo` la corre el dueño** (D-234). Comando exacto en §5.
- **La suite E2E completa no se corrió en local**, por decisión del dueño (había otra sesión en
  paralelo y las dos comparten `test-results/`). El spec nuevo
  `e2e/tests/accesorios-d248.spec.ts` no tiene corrida local: **la juez es la CI del PR**.
- Nada sacrificado: M1–M4 entraron completos.

## 5. Cómo verificar

```bash
# Desde la raíz del worktree acc-demo.
pnpm typecheck      # 4/4 tasks
pnpm lint           # 4/4 tasks
pnpm format:check   # All matched files use Prettier code style
pnpm test           # 53 suites, 707 tests, 0 failed, 0 skipped
```

Los dos specs nuevos de esta sesión, sueltos:

```bash
pnpm --filter @ayr/api exec jest src/production/accessory-math.spec.ts   # 14 passed
pnpm --filter @ayr/api exec jest src/production/roofing-drafts.spec.ts   # 9 passed
```

E2E del flujo (lo corre la CI; en local exige base E2E libre):

```bash
pnpm exec playwright test e2e/tests/accesorios-d248.spec.ts
```

**Migración contra la rama Neon `demo` — la corre el dueño** (D-234), con el entorno de esa rama
ya configurado fuera de la sesión, desde la raíz del worktree:

```text
pnpm --filter @ayr/api exec prisma migrate deploy
```

Aplica las dos migraciones de D-248. Son aditivas: una columna nullable, un valor de enum y dos
CHECK; ningún SKU existente cambia de forma y el API viejo las ignora.

Datos de demo, después de la migración y con `pnpm dev:demo` levantado:

```text
node scripts/oneoff/20260922-demo-accesorios.mjs
```

Números que tienen que salir (verificados contra la app local, base `ayr_acc_demo`):

|                                       |                                                                    |
| ------------------------------------- | ------------------------------------------------------------------ |
| SKU cumbrera 300 mm en rollo de 1 200 | 4 piezas por pasada · 0.714 kg/m                                   |
| Pedido de 36 ML                       | reserva **25.688 kg** de bobina                                    |
| 3 pasadas de 3.00 m                   | 12 piezas · **36.000 m** al kardex · **25.692 kg** menos de bobina |
| A stock: 9 piezas de 3 m              | 27.000 m **disponibles** (reservado 0) a 4.9469 S//m               |

La diferencia de 4 g entre lo reservado y lo consumido es el residuo de redondeo por pieza de
`theoreticalKgPerPiece`, acotado y documentado en `accessory-math.spec.ts`.

## 6. Siguiente sesión

Depende de la validación del cliente. Si valida sin cambios: revisión cruzada por un agente que
no escribió esto (regla 2 de `AGENTS.md`), CI verde y recién entonces la ventana de merge con el
punto de control de D-232. Si el cliente responde alguna de las tres preguntas del guion, esa
respuesta se registra como `D-nnn` **antes** de tocar código.
