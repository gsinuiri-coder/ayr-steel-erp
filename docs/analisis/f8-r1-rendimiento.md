# F8-R1 — Regresión de rendimiento del lote F8 (FASE 1, en curso)

Estado al 2026-09-14 14:05 UTC: **FASE 1 sin cerrar.** Hay un defecto medido y con riesgo real
en producción (`stock-shortages`, §3), pero **no** es la causa del 4-6× de CI (§4). R2, PSE,
polling y `next dev` también quedan descartados (§5). Lo que sigue en pie es Neon. Nada del
producto se tocó. Este documento es el punto de reanudación.

## Contexto

- Ventana V-3 pausada con B-V3-5 abierto: la CI del lote F8 (`9607c23`) se cancela por timeout
  tres veces (75 min, 110 min, 110 min). El control (`e184ca1`, CI de V-2 relanzada el
  2026-09-14 07:40 UTC) cerró 245 passed en 29,8 min.
- **La tercera corrida del lote (10:55 UTC, con Neon ya comprobado sano) se arrastró igual**:
  ~80 tests a los 33 min, ~160 a los 92 min, cancelada a los 110. Descarta que la ventana haya
  coincidido con una degradación de Neon: la regresión es del lote.
- El P2028 («Unable to start a transaction in the given time») cae **en el mismo test** en la
  segunda y la tercera corrida: `fase7d.spec.ts:94`, que crea 26 compras en paralelo.

## Herramientas (quedan para reuso)

Documentadas en `docs/ENTORNOS.md` → «E2E con latencia»:

- `scripts/latency-proxy.mjs` — latencia fija delante del Postgres local + contador de
  round-trips. `--delay 1` ≈ 28 ms por consulta en Windows (medido).
- `scripts/e2e-latency.mjs` — suite desde un worktree con builds de producción, pool de 5,
  base recreada con el esquema del commit.
- `scripts/e2e-roundtrips-reporter.mjs` — duración y round-trips por test en `.jsonl`.
- `scripts/e2e-latency-compare.mjs` — tabla comparativa por spec.

Worktrees en disco: `../wt-r1-base` (`e184ca1`) y `../wt-r1-head` (`9607c23`), ya compilados.
Datos crudos y scripts de un solo uso en `local-data/r1/` (ignorada por git).

## Mediciones

### 1. Suite completa con ~28 ms de latencia (local, pool 5)

|           | Tests | Minutos | Round-trips | Resultado                       |
| --------- | ----: | ------: | ----------: | ------------------------------- |
| `e184ca1` |   248 |    52,2 |     113.627 | 243 passed, 2 failed, 3 skipped |
| `9607c23` |   308 |    79,3 |     187.439 | 301 passed, 4 failed, 3 skipped |

- **Tests comunes (243):** 49,1 → 52,1 min (+6 %), 108.549 → 119.528 RT (+10 %). Por tercios de
  la corrida, RT HEAD/base = 1,02 · 1,12 · 1,15: crece, pero poco.
- **Tests nuevos (65):** 25,8 min, 67.911 RT.
- **La latencia sola NO reproduce el 4-6×.** CI va ~2,3× más lento que esta corrida local de
  HEAD desde el primer tramo (15 tests: 7,8 contra 3,2 min; 80: 33 contra 13,8; 160: 92 contra
  38,7), mientras que la base en CI va _más rápido_ que en local (30 contra 52 min).
- Rojos: los 2 de la base (`fase2a.spec.ts:357` XML de proveedor, `fase5a.spec.ts:94` cobertura
  a medida) fallan en los dos commits en este entorno. Los 2 extra de HEAD (`fase2a.spec.ts:471`,
  `m2-reversa-pago.spec.ts:233`) son de la prueba: bajo latencia el drawer de pago
  (F8-S3b/M4) sigue abierto con «Saldo pendiente: S/ 6,800.00» cuando la aserción busca
  `getByText('S/ 6,800.00')` y el modo estricto encuentra dos elementos.

### 2. Hipótesis descartadas (con medición)

| Hipótesis                      | Experimento                                                       | Resultado                                   |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| CPU del runner (2 vCPU)        | 15 tests comunes con el runner fijado a 2 núcleos (`/affinity 3`) | HEAD/base 1,09×                             |
| CPU del lado de la base        | `pg_stat_database.active_time` en los mismos 15 tests             | 5,5 s (HEAD) contra 5,2 s (base)            |
| Conexiones nuevas (churn, TLS) | contador de conexiones del proxy                                  | 170 conexiones en todas las corridas juntas |
| Clientes Prisma extra          | grep `new PrismaClient`                                           | solo `PrismaService`, igual que en la base  |
| Los 5 `FOR UPDATE` nuevos      | análisis estático (ventana V-3)                                   | caminos cortos o de pocos tests             |

### 3. Defecto medido: `GET /sales/quotations/stock-shortages` (D-188, F8-S2b/M1)

`SalesOrdersService.findStockShortages` recorre **todas** las cotizaciones `EMITTED` y por cada
una llama a `previewLinesOf`: resolución de materia prima, specs, `rawMaterialAvailability`
(varias lecturas, dos por `reservedByItem`), `assertProducible`… en serie, fuera de
transacción, con `Promise.all` sobre el pool. Lo dispara `StockShortagesCard` en el Panel
(`/`), que es donde cae **todo login**, con `refetchInterval: 60_000`.

Benchmark (`local-data/r1/tools/zz-bench-shortages.spec.ts`, cotizaciones a medida de una línea,
un agregado nuevo cada 5):

| Cotizaciones emitidas | Round-trips | Tiempo de reloj | Postgres activo |
| --------------------: | ----------: | --------------: | --------------: |
|                     0 |           3 |           0,1 s |           62 ms |
|                    10 |         175 |           3,7 s |           38 ms |
|                    25 |         415 |           8,5 s |           79 ms |
|                    50 |         813 |          16,8 s |          153 ms |
|                   100 |       1.655 |          34,3 s |          386 ms |
|                   150 |       2.432 |          49,9 s |          429 ms |
|                   200 |       3.238 |      **68,2 s** |          465 ms |

**~16 round-trips por cotización emitida, lineal.** La base de datos casi no trabaja: el
costo es latencia × round-trips, que en local con Docker es invisible.

**Riesgo en producción, independiente de CI:** D-184 convirtió todas las cotizaciones en
borrador a emitidas y D-157 las deja sin vencimiento, así que el conjunto solo crece. Con N
cotizaciones emitidas, cada apertura del Panel cuesta ~16·N consultas mientras ocupa
conexiones del pool, y se repite cada 60 s por pestaña abierta. Desde el deploy de V-3 no hubo
ninguna llamada a ese endpoint en Cloud Run (nadie abrió el Panel).

### 4. Specs 1-31 de HEAD con muestreo de cotizaciones (2026-09-14, 13:20-14:01 UTC)

Proxy `--delay 1`, pool 5, `sampler.mjs` cada 30 s. Datos en
`local-data/r1/head-first31-b.{jsonl,log}` y `local-data/r1/sampler-head-first31-b.jsonl`.

- **158 tests en 39,7 min: 155 passed, 3 failed.** Los tres rojos ya estaban registrados y
  son del entorno: `fase2a.spec.ts:357` (XML), `fase2a.spec.ts:471` (drawer bajo latencia) y
  `fase5a.spec.ts:100` (el mismo de `:94` en la base; afirma «el alta debe dejar el PDF en
  R2», y el worktree no tiene R2).
- El ritmo repite el de la corrida completa de HEAD: 15 tests en 3,3 min (antes 3,2), 80 en
  14,0 (antes 13,8). La medición es estable.
- **Cotizaciones `EMITTED` a lo largo de la corrida: máximo 2, promedio 0,12**; 0 en 73 de 82
  muestras. La suite crea 59 y anula 57 casi enseguida. Una carga del Panel cuesta entonces
  a lo sumo ~35 round-trips.
- `fase7d.spec.ts:94`, el test del P2028 en CI, **pasa en local en 6,3 s** con pool 5 y
  latencia: las 26 compras en paralelo no agotan el pool en este entorno.

**Conclusión:** `stock-shortages` **no explica** la lentitud de CI. Queda como defecto de
producción (§3, FASE 2), pero la causa del 4-6× es otra.

### 5. Otros caminos que solo corren en CI, descartados

| Candidato                             | Evidencia                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF a R2 en cada alta/edición (D-184) | Antes solo al emitir. En los specs 1-31 son 62 subidas en total. Los logs de CI sí muestran la salida del API (`[WebServer]`, ahí están los P2028) y en las tres corridas no hay ni un `No se pudo generar el PDF`: R2 respondió sin fallos ni reintentos colgados. No alcanza para minutos. |
| PSE (Nubefact) en caminos calientes   | El diff del lote no agrega llamadas al PSE fuera de las acciones explícitas de comprobante.                                                                                                                                                                                                  |
| Polling nuevo del web                 | Solo dos `refetchInterval: 60_000` (`stock-shortages-card`, `reservas-temporales`).                                                                                                                                                                                                          |
| `next dev` en CI                      | CI compila y usa `web start`/`api start`, igual que el runner local.                                                                                                                                                                                                                         |
| Padrón (apis.net.pe)                  | CI y local usan el mismo `e2e/padron-stub.mjs`, sin cambios en el lote.                                                                                                                                                                                                                      |

Límite: CI usa el reporter `github` (puntos), sin duración por test, así que la corrida de CI
no se puede cruzar test por test con la local. Para aislar dónde se va el tiempo en CI hace
falta una corrida con reporter `list` (o el `.jsonl` de round-trips) **en CI**.

### 6. CI instrumentada: la forma de la divergencia

Rama `diag/f8-r1-instrumentacion` (desde `9607c23`, no se mergea): reporter `list` y una línea
`[r1]` por test con consultas a la base y su duración. Las mide un preload
(`scripts/diag/prisma-query-stats.cjs`, vía `NODE_OPTIONS`) que escucha el evento `query` de
Prisma solo en el proceso del API, sin cambios de producto. `queryMs` es la duración que
informa el motor por consulta; si hay consultas en paralelo, la suma puede superar el reloj.

Validación local: con el proxy a ~28 ms, el preload da 28-44 ms por consulta. En un test de
27,3 s, 663 consultas suman 25,9 s. Cuenta menos que el proxy (el proxy también ve los helpers
de Playwright y mensajes de protocolo), así que **CI y local se comparan con el mismo
preload**: `local-data/r1/diag-local-first31.jsonl` (specs 1-31, 155 passed, 39,9 min).

**HEAD en CI** (run 34859319029, 2026-09-14 15:04-16:52 UTC, cancelado por timeout a los 110
min con 207 tests y sin P2028). Cruce con local sobre 161 tests (`local-data/r1/shape-head.txt`):

|                           |    Local |       CI |      CI/local |
| ------------------------- | -------: | -------: | ------------: |
| Reloj                     | 39,1 min | 81,6 min |         ×2,09 |
| Consultas                 |   60.508 |   61.713 |     **×1,02** |
| ms por consulta (total)   |     33,7 |     78,6 |     **×2,33** |
| Tiempo en consultas       | 34,0 min | 80,9 min |               |
| Tiempo fuera de consultas |  5,1 min |  0,7 min | (paralelismo) |

- **Mismas consultas, cada una más lenta.** No es más volumen: es un costo fijo por consulta.
- **Uniforme, no puntual.** ×reloj por test: p10 1,41 · p25 1,95 · mediana 2,13 · p75 2,27 ·
  p90 2,40. El ms por consulta de CI, por test (tests con ≥20 consultas): p5 61 · mediana 78 ·
  p95 92. Hasta los tests de `auth`, con 6-30 consultas y sin locks, pagan 68-111 ms. La única
  excepción, `fase5a.spec.ts:100` (×5,7), hace el doble de consultas porque en CI sigue el
  camino de R2 que en local falla.
- **No crece con el avance.** ×reloj por quintos: 2,04 · 1,85 · 2,20 · 2,29 · 1,94. No hay nada
  que se acumule.
- **Locks, puntuales.** Hay esperas largas aisladas (`INSERT … idempotency_keys ON CONFLICT` 6,9 s,
  `SELECT … coils FOR UPDATE` 3,8 s, `UPDATE production_orders` 1,7 s), pero no mueven la mediana.
- El diff del lote no cambia nada que agregue costo por consulta: misma versión de Prisma,
  mismo `schema.prisma` (generator/datasource) y ningún `$extends`, `SET` por transacción ni
  parámetro de conexión. Solo `maxWait`/`timeout` en cuatro `$transaction`.

**Lo que la forma no alcanza a decir:** la base `e184ca1` cerró en CI en 29,8 min el mismo día
(07:40 UTC, entre dos corridas lentas del lote a las 05:40 y 10:55). Con este perfil, eso
exige ~20-25 ms por consulta. O el piso depende de la corrida (red runner→Neon, región del
runner, estado del pooler) y la base tuvo suerte, o algo del lote lo sube de una manera que
el diff no muestra. Eso lo decide el A/B.

**A/B sobre la base en CI:** rama `diag/f8-r1-instrumentacion-base` (desde `e184ca1`), con la
misma instrumentación más `scripts/diag/db-rtt.mjs`: RTT TCP del runner al pooler y al host
directo, y región de Azure del runner, antes y después de la suite (solo milisegundos; ni host
ni credenciales). Resultado: pendiente.

## Lo que falta para cerrar FASE 1

1. ~~¿Explica `stock-shortages` el 4-6× de CI?~~ **No** (§4).
2. **Lo que CI tiene y el entorno local no:** Neon (pooler/pgbouncer en `CI_DATABASE_URL`,
   cómputo mínimo, caché fría), credenciales de PSE y R2, y `E2E_CUSTOMER_RUC`. La lentitud de
   CI aparece desde los primeros 15 tests, así que lo que la cause ya está activo al arrancar.
   PSE y R2 quedan descartados (§5). Candidatos que siguen: el pooler de Neon —el P2028 de
   `fase7d.spec.ts:94` no se reproduce en local con pool 5, así que en CI algo retiene las
   conexiones más tiempo— y consultas que en Neon cambian de plan. El paso más barato para
   ubicarlo es una corrida de CI con duración y round-trips por test (§5, límite).
3. **Plan B del brief (Neon `dev`)** si lo anterior no alcanza: el guard de
   `reset-test-db.ts` solo permite `ayr_local_e2e` y la rama `ci`, así que medir en Neon
   requiere decidir cómo (credenciales por entorno, regla dura 5).

## Pendiente de FASE 2 ya identificado (sin tocar todavía)

- `findStockShortages`: dejar de recalcular cotización por cotización. Opciones a evaluar con
  el límite duro del brief (misma cuenta que el gate de confirmar, D-150): cargar en lote los
  specs, saldos y reservas de todos los ítems involucrados y resolver en memoria; o cachear
  por request. Sacar el refetch de 60 s si no hay pestaña visible.
- Fragilidad de `fase2a.spec.ts:471` y `m2-reversa-pago.spec.ts:233` bajo latencia (selector de
  saldo que choca con la descripción del drawer).
