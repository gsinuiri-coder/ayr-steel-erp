# F8-R1 — Regresión de rendimiento del lote F8 (FASE 1, en curso)

Estado al 2026-09-14 13:10 UTC: **FASE 1 sin cerrar.** Hay un defecto medido y con riesgo real
en producción, pero todavía no está probado que sea la causa del 4-6× de CI. Nada del
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

## Lo que falta para cerrar FASE 1

1. **¿Explica este endpoint el 4-6× de CI?** El dato que falta es cuántas cotizaciones
   `EMITTED` tiene la suite a lo largo de la corrida. Un primer muestreo de los specs 1-31
   (`local-data/r1/tools/sampler.mjs`) mostró solo 6 cotizaciones, todas `CANCELLED`, en los
   primeros minutos: si la suite deja pocas emitidas, el endpoint no alcanza a explicar la
   lentitud temprana de CI, y hay que seguir buscando algo más.
   - Retomar: proxy (`--delay 1 --stats-port 5499`), `sampler.mjs` en background y
     `scripts/e2e-latency.mjs --worktree ../wt-r1-head` sobre los specs 1-31 (orden
     alfabético, hasta `fase7d.spec.ts`).
2. **Lo que CI tiene y el entorno local no:** Neon (pooler/pgbouncer en `CI_DATABASE_URL`,
   cómputo mínimo, caché fría), credenciales de PSE y R2, y `E2E_CUSTOMER_RUC`. La lentitud de
   CI aparece desde los primeros 15 tests, así que lo que la cause ya está activo al arrancar.
   Candidatos a verificar: caminos nuevos que solo se ejecutan con PSE/R2 configurados, y
   consultas que en Neon cambian de plan.
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
