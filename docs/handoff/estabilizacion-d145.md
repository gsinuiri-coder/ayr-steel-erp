# Handoff — Sesión de estabilización pre-recarga de agosto — 2026-09-08

## 1. Resumen

Sesión de estabilización, no una fase. **M0 era el objetivo y se cerró**: el flujo de "OP de
coberturas a stock" (D-140) estaba roto desde que se desplegó, y nadie tenía el repro. La
causa era un `CHECK` de la Fase 6 que nadie actualizó cuando D-140 cambió la regla, más un
segundo defecto que ese constraint destapó. Una decisión nueva, **D-145**.

M1 (tolerancia de reserva de MP) se **verificó**, no se construyó: ya estaba en `main` y
cubierta; queda el checklist de deploy escrito y **nada desplegado**. M2 (ensayo de recarga de
agosto en `demo`) se hizo el paso 0 —demo estaba 3 migraciones atrasada, ya no— y **el dueño
decidió no reimportar**. M3 no se tocó.

`pnpm turbo lint typecheck test` verde (293/293) y `pnpm build` verde. **Nada commiteado hasta
tu visto bueno.** Producción no se tocó en ningún momento, ni para leer.

---

## 2. Hecho

### M0 — el flujo de OP a stock estaba roto en la base (D-145)

**El síntoma:** `POST /api/production/roofing` con `productId` + `targetPieces` —la orden a
stock que ofrece `/planta` y que arma el CLI de importación— devolvía **`500 Internal server
error`**, sin ningún mensaje.

**Reproducido en local (Docker) antes de tocar una línea de código.** El error real que el 500
tapaba:

```
PrismaClientUnknownRequestError en tx.productionOrder.create()
  apps/api/src/production/roofing-production.service.ts:318
PostgresError 23514: new row for relation "production_orders"
  violates check constraint "production_orders_roofing_contra_pedido"
```

**Dos causas, la segunda destapada por arreglar la primera:**

1. **El `CHECK` de Fase 6 nunca se actualizó.** `production_orders_roofing_contra_pedido`
   (migración `20260904180000_fase6_coberturas_color`, D-084) exige `reservation_id IS NOT
NULL` en toda OP `ROOFING`. D-140 —que vos resolviste el día anterior— introdujo
   `createToStock`, que crea exactamente eso: una OP `ROOFING` **sin reserva**. El código
   nuevo y la base quedaron diciendo cosas opuestas.
2. **`createToStock` no guardaba `targetPieces`.** Lo valida y lo audita, pero no lo pasaba al
   `data` del `create` (drywall sí, desde D-048). Se vio recién al aplicar el fix del
   constraint: el insert seguía fallando porque `target_pieces` llegaba `null`. Además de
   romper el constraint nuevo, dejaba `/planta` y `/produccion` mostrando **«Meta: —»** en la
   única clase de orden que la tiene por definición.

**Por qué llegó desplegado.** Los unitarios de `production` son de aritmética pura (Prisma
mockeado: un `CHECK` de la base les es invisible), y el E2E de Fase 6 cubre el **rechazo** de
D-140 y **se detiene en la frase que nombra la salida** —"producí una orden a stock desde
planta"— sin recorrerla nunca. La mitad prohibida estaba probada; la permitida, no.

**El arreglo:**

- `apps/api/prisma/migrations/20260908150000_d145_allow_roofing_production_order_to_stock/migration.sql`
  — el constraint pasa a `production_orders_roofing_contra_pedido_o_a_stock`, con forma
  `kind <> 'ROOFING' OR reservation_id IS NOT NULL OR target_pieces IS NOT NULL`.
- `apps/api/src/production/roofing-production.service.ts` — el `targetPieces` que faltaba.
- `apps/api/prisma/schema.prisma` — el invariante documentado sobre `targetPieces` (Prisma no
  sabe declarar un `CHECK`, así que el comentario es su único rastro en el repo).

**No se tocó el kardex ni `InventoryService.record`.** El resto del ciclo a stock (`mountCoil`,
`report`, `close`, `reverseReport`, `cancel`) ya trataba `reservationId` como opcional y no
necesitó un solo cambio: `mountCoil` filtra la bobina por el espesor y el color **del
producto**, no de la reserva.

**La regresión, roja antes y verde después** — `e2e/tests/fase7final-op-a-stock.spec.ts`:

- **Ciclo completo a stock**: crear sin reserva → montar → rolar 5 planchas de 4 m (80 kg
  teóricos) → cerrar declarando 83 kg (3 kg de despunte) → kardex de la bobina en
  `IN:PURCHASE` / `OUT:PRODUCTION` / `OUT:SCRAP`. Verifica **lo que D-140 decidió**: sin
  pedido detrás no hay promesa que trasladar (D-088), así que las planchas entran como **saldo
  libre** (`reservedQty = 0.000`, `availableQty = 5.000`) y el pedido de catálogo que esperaba
  puede reservarlas después.
- **La cobertura a medida sigue sin camino a stock**: sin pedido no hay largo que fabricar.

### M1 — la tolerancia ya estaba; queda el checklist

**Verificado, no construido.** `ROOFING_THICKNESS_TOLERANCE_MM = '0.02'` vive en
`@ayr/shared` (con override por entorno) y la igualdad estricta de color es D-085. Último
commit que las tocó: `8bfa5bb`. Cobertura existente:

- **Unit**: `roofing-math.spec.ts` fija el borde exacto (0.32 y 0.28 pasan contra 0.30; 0.33
  no); `raw-material.spec.ts` comprueba que el agregado suma 0.44 y 0.46 para una spec de 0.45
  y descarta otro color.
- **E2E**: `fase7final-m1` (5/5) y `fase6-bordes` caso 1.

**Smoke sobre el artefacto compilado, contra Docker.** `pnpm build` verde y después la suite
corrida con `CI=true` contra el Postgres local — que es lo que hace que Playwright levante
`node dist/main.js` + `next start` en vez de `nest start` + `next dev`, o sea **la misma forma
que corre en Cloud Run**: 14/14 verdes.

### M2 — paso 0 hecho, el resto parado por decisión tuya

- **`demo` estaba 3 migraciones atrasada** respecto de `main`:
  `20260907180000_fase7finalb_origen_del_pedido`,
  `20260907190000_fase7finalb_import_batch_id_ventas` y `20260908150000_d145_...` (el fix de
  M0). Las tres aplicadas con `pnpm db:demo`. Sin incidentes.
- **Inventario de demo** (solo lectura): es el clon de production al 2026-09-06, o sea **de
  antes** de la limpieza, así que arrastra todo el residuo E2E de entonces — 1 985 bobinas
  (1 927 `CANCELLED`, 48 `OPEN` con 120 729 kg), 1 617 productos (mayoría `BOBE2E…`/`IMP-OK-…`),
  968 acabados, 6 836 movimientos de kardex, 219 pedidos (215 `CANCELLED`).
- **Dry-run de ventas contra demo**: el archivo es efectivamente el de agosto (141 filas, 71
  documentos, 03/08 → 31/08). **40 SKUs faltantes** (demo no tiene los 55 productos de
  Metallic Roofing que creaste en production el 07-09, posteriores al clon), **ninguna unidad
  sin mapear**, 1 nota de crédito excluida con su motivo (`FFC1-73`). Ningún documento
  confirmado: el dry-run no escribe negocio.
- **No se ejecutó la importación** — decidiste no reimportar.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-145** | Una OP de coberturas nace de una reserva **o** de una meta a stock, y el `CHECK` de la base lo dice así — en vez de exigir siempre la reserva (D-084) o de no exigir nada (que era la otra opción). |

Detalle largo en `docs/ARQUITECTURA.md` §0.2: por qué relajar y no borrar el constraint, cuál
era el segundo defecto que traía adentro, y por qué el hueco de tests dejó pasar las dos cosas.

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Rehacer `local-data/Ventas Detalladas.decisiones.json`.** Correr el dry-run con
  `--decisions` apuntando a ese archivo **lo pisó**: el esqueleto que el dry-run escribe va,
  por defecto, a `<archivo>.decisiones.json`, que es exactamente el nombre del tuyo. Se
  perdieron las **40 líneas de negocio** asignadas SKU por SKU y los **23 comprobantes
  marcados como pendientes**. No estaba en git (`local-data/` es ignorada) ni en `dev`.
  Elegiste rehacerlo a mano en vez de autorizar una lectura de `production` para recuperarlo.
  El esqueleto vacío (con los 40 SKUs, su nombre y su unidad ya detectados) quedó escrito ahí.
  **Ya no puede repetirse**: `safeScaffoldPath` en `apps/api/prisma/import-ventas-cli.ts` hace
  que el dry-run nunca pise un archivo que ya existe, y que un `--out` igual a `--decisions`
  aborte con el motivo. Misma clase de defecto que D-128: una herramienta que hace algo
  destructivo por defecto en el camino más natural de usarla.
- **`vercel login`** sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push.

### Lo que quedó fuera, y por qué

- **M3 (7f: renombres + pulido de cotización + página del importador) no se empezó.** Su
  alcance no está escrito en ningún lado del repo — el único ticket 7f registrado
  (`docs/PROGRESO.md`) es que la creación e importación de Metallic Roofing exija `finish_id`
  de forma más visible. Qué se renombra y a qué, y qué falta pulir de la cotización, hace
  falta que lo nombres vos; adivinarlo habría sido inventar alcance.
- **La mitad de bobinas de M2 nunca se corrió**: no existe ningún archivo de bobinas de agosto
  en `local-data/`, solo el de ventas.
- **Si el ensayo de agosto se retoma, conviene rehacer `demo` desde `production`** antes de
  cargar nada (procedimiento en `docs/ENTORNOS.md`): hoy demo arrastra el residuo E2E que
  production tenía el 06-09 y que ya se limpió del lado real.

### Anotado, no tocado

- Aparecieron en el árbol de trabajo tres cosas que **no son de esta sesión** y que dejé sin
  commitear: `docs/analisis/`, `e2e-report.json` y `subset.json` (este último, 118 KB de
  salida de Playwright con BOM, **rompe `pnpm format:check`** y no está cubierto por
  `.gitignore`). Si son tuyos, decidí vos qué hacer; si son basura, van al `.gitignore` o a la
  papelera.
- **Detuve dos servidores tuyos** (:3000 corriendo desde `apps/api/dist/main` —código anterior
  a esta sesión— y :3001 `next dev`) para poder correr los E2E contra el código real. Los
  relevantás con `pnpm dev:local`.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test        # verde (293/293 unitarios)
pnpm build                            # verde
pnpm format:check                     # verde salvo subset.json, que no es de esta sesión
pnpm e2e fase7final-op-a-stock        # 2/2 — la regresión de D-145
pnpm e2e fase6 fase6-bordes           # 12/12 — sin regresiones en coberturas
pnpm e2e fase7final-m1                # 5/5 — la tolerancia de MP (D-134)
```

Corré **tandas chicas**: el token de acceso dura 15 minutos y un archivo que tarde más se cae
con un 401 a mitad.

Para smokear el artefacto **compilado** (lo que corre en Cloud Run) sin desplegar:

```bash
pnpm build
# Con CI=true, playwright.config.ts levanta `node dist/main.js` + `next start` en vez de
# `nest start` + `next dev`, pero deja de rellenar solo las variables del Docker local: hay
# que pasarle DATABASE_URL, DIRECT_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD y
# E2E_RESET_DB=1. **Los cinco valores salen de `scripts/local-docker-env.mjs`**, que es donde
# viven las constantes del Postgres de Docker — no se copian a mano ni se repiten en un doc.
CI=true E2E_RESET_DB=1 <variables de scripts/local-docker-env.mjs> \
  pnpm e2e fase7final-op-a-stock fase6
```

### Checklist de deploy — listo, sin correr, esperando tu OK

```bash
# 1. Todo verde y commiteado; CI verde en GitHub Actions (D-123)
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e

# 2. Migración
pnpm db:prod            # aplica 20260908150000_d145_... y lo que production tenga pendiente

# 3. API
pnpm deploy:api

# 4. Web: por push a main (integración Vercel-GitHub); el CLI sigue con el token vencido

# 5. Verificación post-deploy, SOLO LECTURA (D-126)
pnpm smoke:prod
```

**Esta vez el orden sí es seguro**, a diferencia del aviso de la sesión anterior: la migración
de D-145 **afloja** un `CHECK`, no lo endurece ni cambia ninguna columna. El API viejo
corriendo contra la base ya migrada funciona exactamente igual —nunca intenta insertar una
fila que el constraint nuevo rechace y el viejo aceptara—, así que no hay ventana de
incompatibilidad entre el paso 2 y el 3. **No hace falta que nadie deje de operar.**

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126): producción tiene datos reales.

---

## 6. Siguiente sesión

1. **Decime el alcance de 7f** (qué se renombra, qué falta pulir de la cotización, qué querés
   de la página del importador) y lo hago: es lo único de esta sesión que quedó sin empezar
   por no estar escrito.
2. **Fase 8** (auditoría, reportes, UAT), que sigue siendo la siguiente según §3.7.
3. Si retomás la carga de agosto: rehacer `demo` desde `production`, rehacer el JSON de
   decisiones, y recién ahí el dry-run.
