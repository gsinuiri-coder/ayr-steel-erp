# Revisión de segundo modelo: cc43 (E2E en 2 shards, D-596)

- **Fecha:** 2026-10-10
- **Revisor:** segundo modelo, Sonnet, contexto limpio (no es una persona; AGENTS.md §2, punto 2.2).
- **Alcance:** `git diff origin/main...HEAD` (solo `.github/workflows/ci.yml`) más el diff sin commitear de
  `docs/ARQUITECTURA.md`, `docs/DECISIONES.md` y `docs/ENTORNOS.md`.
- **Método:** solo lectura. No se corrió la CI ni la suite. Lo que depende de cómo se comporta
  GitHub Actions o Nubefact **no se ejecutó**: sale de la documentación y de leer el código.
  La ausencia de dependencias entre specs **no se verificó archivo por archivo** (hay más de 100 specs);
  se comprobó la configuración (`workers: 1`, `fullyParallel: false`, un `globalSetup` por shard) y se
  muestreó, no se barrió.

Resumen: 0 P0, 1 P1, 4 P2, 2 P3.

---

## Hallazgos

### P1-1. Los dos shards parten del mismo correlativo fiscal (por reloj) y emiten contra la misma cuenta demo de Nubefact

- **Archivos:** `apps/api/prisma/e2e-fiscal-offset.ts` (`runCorrelativeBase`, `FLOOR + epoch_s mod 80 000 000`),
  invocado desde `e2e/global-setup.ts` tras cada reset; `.github/workflows/ci.yml` (matrix de `e2e-shard`,
  `NUBEFACT_URL`/`NUBEFACT_TOKEN`/`E2E_CUSTOMER_RUC` en el `env` del job).
- **Escenario:** los dos shards arrancan en paralelo y construyen casi igual (misma duración de build), así
  que sus `globalSetup` corren con segundos de diferencia. Cada uno fija el correlativo de todas sus series
  en `10 000 000 + epoch_s` de su propio instante. Dos shards separados por, digamos, 20 s emiten números
  que se pisan en un rango de unas decenas de números (cada uno emite cientos de comprobantes con RUC real
  si `E2E_CUSTOMER_RUC` está definido). Mismas series (F001, B001…) y misma cuenta demo: Nubefact responde
  «documento ya existe» o rechaza por la ventana de 200 números (D-365). Antes había una sola corrida por
  cuenta, así que la unicidad la daba el reloj; ahora la rompe la concurrencia que introduce el cambio.
  Los casos que emiten (`fase5b*.spec.ts`, `fase7b.spec.ts`, `reportes-costeo-rf-s4a.spec.ts`, `helpers/invoicing.ts`)
  caerían en uno u otro shard según el reparto, y el rojo sería intermitente y sin relación aparente con el código.
- **Corrección sugerida:** separar los espacios de numeración por shard: pasar `E2E_SHARD` por el entorno
  y que `e2e-fiscal-offset.ts` sume `shard * 1_000_000` a la base (o parta `RANGE` en dos). Alternativa más
  barata: correr con RUC vacío solo el shard 2 (los casos de aceptación se saltan solos), pero pierde cobertura.
  También conviene decir en D-596 que la cuenta demo es compartida. Si el equipo ya midió que esos casos no
  emiten en CI (RUC vacío), dejarlo escrito y bajar a P3.

### P2-1. D-596 y el comentario del job citan un handoff que no existe

- **Archivo:** `docs/ARQUITECTURA.md` (fila D-596, «Medidas en `docs/handoff/ventana-cc43.md`»);
  `.github/workflows/ci.yml` (comentario de `base`: «run 38101351095»).
- **Escenario:** `docs/handoff/ventana-cc43.md` no está en el árbol (el directorio solo tiene
  `docs/handoff/ventanas/` y archivos sueltos antiguos). Una fila de §0.2 que remite a una medida inexistente
  deja la cifra «39 min 11 s» y «7,5 min» sin respaldo en el repo. Si el handoff se escribe en el cierre,
  no pasa nada; si no, queda colgado. Confirmar que se crea antes del merge.

### P2-2. Referencias que quedaron viejas: `check:drift` ya no corre en el job `e2e`

- **Archivos:** `docs/ARQUITECTURA.md` fila D-593 («`pnpm check:drift` (job `e2e`)»), `docs/ENTORNOS.md:366`
  («Corre en el job `e2e` de…»), `docs/PROGRESO.md:17` («Guardián: `pnpm check:drift` en el job `e2e`»),
  `docs/analisis/drift-schema.md:62` («el Postgres de servicio del job E2E») y el comentario de
  `apps/api/jest.db.config.js` («En CI van en el job de E2E»).
- **Escenario:** quien busque el guardián del drift o `test:db` en la CI lo busca en un job que ya no los corre
  (ahora `base`, «Drift y kardex contra la base»). Para el check de rama, el job agregado `e2e` sí depende de
  `base`, así que la frase «cuenta para el check E2E» sigue siendo cierta, pero «corre en» no.
  D-596 no dice que mueve D-593; la fila de D-593 acaba de reescribirse en este mismo diff y no se corrigió.

### P2-3. El agregado `e2e` se salta la condición «calidad» de forma implícita y se llama igual que el job viejo

- **Archivo:** `.github/workflows/ci.yml` (job `e2e`, `needs: [base, e2e-shard]`, `if: always()`).
- **Escenario:** verificado por lectura, no hay forma de dar verde con un fallo: `needs.<job>.result` vale
  `success` solo si todas las instancias de la matrix terminaron en `success`; `failure`, `cancelled` y `skipped`
  (p. ej. `calidad` roja, que deja `base` y los shards en `skipped`) hacen fallar el `test`. El job es de 5 min
  y no depende de `calidad` directamente, pero llega transitivamente. Dos salvedades, sin llegar a defecto:
  (a) el job corre ahora con `if: always()` incluso en ejecuciones **canceladas** por otra ejecución y
  quedará como rojo ruidoso (puede enmascarar la causa en un `concurrency`/`cancel-in-progress`);
  (b) los checks de GitHub se identifican por nombre: ahora existen tres nombres nuevos
  («Drift y kardex contra la base», «E2E Playwright, shard 1/2» y «2/2») y uno que conserva el viejo. Como
  `main` no tiene protección ni rulesets (verificado por el autor con la API), no hay regla que se rompa, pero
  cualquier integración externa (Sonar, un bot) que lea el check por nombre sigue viendo el de siempre.
- **Sugerencia:** añadir `contains(needs.*.result, 'cancelled')` solo si se quiere distinguir; no es necesario.

### P2-4. El reparto por shard no está equilibrado por tiempo y el tope de 30 min no tiene margen medido

- **Archivo:** `.github/workflows/ci.yml` (`timeout-minutes: 30` por shard, `pnpm e2e --shard=i/2`).
- **Escenario:** con `fullyParallel: false` Playwright 1.62 reparte **archivos enteros** equilibrando por
  cantidad de tests, no por duración. Los `fase*.spec.ts` y los de emisión PSE (lentos, red real) pueden
  caer juntos. El job viejo llegó a 39 min con `test:db` incluido (~7,5 min con `check:drift`); la suite sola
  rondó unos 31 min, es decir ~15 min por mitad si el reparto fuera perfecto. Un desequilibrio de 2:1 deja
  un shard en ~21 min más build y navegadores (~4–5 min): ajustado frente a 30. Nadie midió una corrida
  real de los shards (la entrega no la cita; D-596 habla de «medidas» en el handoff que no existe, ver P2-1).
  Con `fail-fast: false` un shard que se corta a los 30 sin rojo es indistinguible de un cuelgue.
- **Sugerencia:** dejar escrito el tiempo real de ambos shards en el primer run verde y subir el tope a 35
  si alguno pasa de 22 min.

### P3-1. `retries: 1` en CI ahora se aplica a cada shard sin cambiar nada, pero el artefacto de reporte solo sale con `failure()`

- **Archivo:** `.github/workflows/ci.yml` (paso `upload-artifact` con `if: failure()`).
- **Escenario:** los nombres `playwright-report-shard-1` y `-2` no chocan (verificado). Un test que pasa solo
  en el reintento (flaky) no genera artefacto ni deja rastro, igual que antes. Sin cambio de comportamiento;
  se anota para que nadie espere un reporte de un shard verde con reintentos.

### P3-2. `ENTORNOS.md`: la nota «demo está apagada» no es verificable desde el repo

- **Archivo:** `docs/ENTORNOS.md` (párrafo «Estado al 2026-10-10 (cc43)»).
- **Escenario:** afirma que el `dev:demo` de cc38 se detuvo y que la rama `demo` no tiene la migración de
  cc41. Lo segundo es coherente con el flujo (la migración se aplicó a producción, D-591, y demo se restablece
  desde producción, D-227), pero no hay forma de comprobarlo leyendo el repo, y el texto es un estado
  puntual con fecha dentro de un documento de runbooks. Está bien con la fecha puesta; conviene cerrar la nota
  cuando demo se restablezca. La ratificación de D-592..D-595 sí es exacta: las cuatro filas dicen
  «ratificada por el dueño el 2026-10-10 (cc43)» y la sección nueva de `DECISIONES.md` nombra las mismas cuatro.
  Solo falta, si se quiere, que D-596 cite que sigue «pendiente de ratificación» (lo dice).

---

## Revisado y sin hallazgo

- **Argumentos a Playwright:** `pnpm e2e --shard=${{ matrix.shard }}/2` con pnpm 9.13.2 pasa `--shard=1/2`
  tal cual a `playwright test` (sin `--` intermedio, que es el caso problemático que advierte AGENTS.md §5).
  `--shard` es una opción de línea de comandos válida; el `grepInvert` de `@pse` convive con él.
- **Entorno de `base`:** tiene `DATABASE_URL`/`DIRECT_URL`, `ALLOW_DB_RESET`, `CI`, `JWT_SECRET`, admin y
  `SEED_ADMIN_FOR_TESTS` en el paso de `test:db`; hace `shared build` y `db:generate`. `test:db`
  (`reset-test-db` + `seed` + `jest -c jest.db.config.js`) y `check:drift` (que usa `GITHUB_ACTIONS` y
  `DATABASE_URL`, reescribe el nombre de la base a `ayr_drift_check`) no necesitan el build del API ni del web.
  El guard de `test-db-guard.ts` admite `ayr_ci_e2e` en localhost con `GITHUB_ACTIONS=true`: se cumple.
  `base` no declara `E2E_*` ni `E2E_CUSTOMER_RUC`: no los usa.
- **Shards:** conservan todo el entorno anterior, el build del API y del web y el `globalSetup` que resetea,
  migra, siembra y adelanta el correlativo sobre **su** Postgres de servicio (cada job tiene el suyo, en el
  puerto 5432 de su propio runner; no se comparte base).
- **Nombres de artefactos:** distintos por shard; ningún otro job sube `playwright-report`.
- **Otros jobs:** ninguno hace `needs: e2e`; `smoke-neon`, `escenarios` y `analisis` no cambian.
- **Dependencias entre specs:** con `workers: 1` y archivos enteros por shard, un spec que leyera datos de
  otro archivo ya se rompería hoy con un `--grep`/`e2e:smoke`; no se encontró en la muestra revisada (los
  `serial` están dentro de un mismo archivo, que no se parte). No se leyeron todos los specs.
