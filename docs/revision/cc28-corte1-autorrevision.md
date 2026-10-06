# cc28 — corte 1: autorrevisión

> **Autorrevisión, no aprobación.** La hizo un subagente nuevo que no leyó el handoff de
> implementación de cc28 (AGENTS.md §2, regla 2.1). Es una **lista de riesgos**, no un pase
> cruzado. No reemplaza al segundo modelo ni la revisión del dueño.

- Alcance: `git diff origin/main...HEAD` en `cc28-limpieza` (commits `b6d6da82..044f1dd2`): M1
  (corte), M2 (panel del vendedor, vista previa del cierre, `.strict()` del mostrador), M3
  (AGENTS.md) y M4 (scripts de demo).
- Corridas (solo lectura): `pnpm --filter @ayr/api test` sobre `lock-order.contract.spec.ts`,
  `close-preview.spec.ts`, `pos-math.spec.ts` y `src/reports`: **25 suites, 244 tests, verdes**.
  `pnpm test:scripts`: **52 tests, verdes** (incluye `demo-env-path.test.mjs`). **No** se corrió
  `test:db` (`lock-order.db-spec.ts`): sus aserciones se revisaron leyendo el código, sin correrlas.
- Cada hallazgo se comprobó en el código; donde una afirmación depende de una medida que no
  existe, se dice.
- **Las líneas citadas son las del commit `044f1dd2` (HEAD).** Mientras se revisaba, el worktree
  tenía cambios **sin commitear** en 11 archivos del mismo diff (`AGENTS.md`, `close-preview.ts`,
  los tres servicios de producción, `lock-order.db-spec.ts`, `seller-sales-card.tsx` y los scripts
  de demo), por lo visto arreglos en curso. **No se revisaron**; puede que cierren algunos
  hallazgos. Esos cambios necesitan su propio pase. Los tests de arriba corrieron sobre el árbol de
  trabajo de ese momento.

## Lo que se comprobó y no dio hallazgo

- **Orden de bloqueos del corte (M1).** Los únicos que escriben `cutting_order_coils` o
  `cutting_orders` están en `cutting.service.ts` (grep en `apps/api/src`, fuera de specs). Queda:
  `receive` orden → fila → bobina (`lockCoil`); `reverse` orden → fila → `lockInOrder` →
  `lockCoil`; `cancel` orden → filas por id → `lockInOrder`. `send` crea una orden nueva (no hay
  fila previa que alguien más tenga). `recomputeOrderStatus` solo corre dentro de esas tres, con la
  orden ya tomada. `purchases.service.ts#applyCuttingOrderCost` lee la orden sin bloquearla, sin
  escribirla. Ningún camino toma bobina o saldo y después la orden de corte: no aparece un ciclo
  nuevo. El deadlock de antes (fila → orden en `receive` al recalcular, orden → fila en `cancel`)
  queda cerrado. Efecto colateral aceptable: dos recepciones de bobinas distintas de la misma
  orden ahora se encolan.
- **Vista previa del cierre (M2).** Las tres acciones que la vista previa replica (`closeInTx` de
  drywall y coberturas; `commitInTx` vía `loadState`) toman `production_orders` primero con el
  mismo `lockOrder`: tomarlo antes en `previewPlantClose` no invierte ningún orden.
- **`.strict()` del mostrador.** El web manda `productId`, `qty` y lo que devuelve
  `posLinePayload` (`unitPricePen` **o** `unitPriceWithIgvPen`, o nada si es `null`):
  `apps/web/src/app/(app)/pos/pos-view.tsx:146-150`, `apps/web/src/lib/pos-pricing.ts:67-76`. Los
  helpers E2E (`e2e/helpers/pos.ts`, `PosSaleInput.items`) y todas las llamadas de `e2e/tests`
  pasan solo `productId`, `qty` y `unitPricePen`. Ningún otro código usa `posSaleItemInputSchema`.
  `.strict()` va solo en el ítem; el objeto de la venta sigue aceptando `notes` (que `posSell`
  manda) como antes.
- **Panel del vendedor.** `SalesOrderStatus` tiene un solo estado muerto (`CANCELLED`); el filtro
  `some: { status: { not: CANCELLED } }` es la regla de D-459. El E2E cubre el caso (cotización con
  pedido anulado no cuenta, 33,3 %). El `test.skip(!fiscalEmissionAllowed())` nuevo no recorta
  cobertura: el archivo ya se salta entero con `E2E_BASE_URL`, y sin él `fiscalEmissionAllowed()`
  es `true`.
- **Scripts de demo.** Ningún camino nuevo imprime ni copia secretos: `howToFix` lleva rutas, no
  contenido; `env-demo.mjs` sigue escribiendo el archivo sin imprimirlo.

## Hallazgos

### A-1 — P2 — AGENTS.md dice que el push directo a `main` está denegado, y `.claude/settings.json` lo permite

`AGENTS.md:108-123` (regla 1, «El push directo a `main` está denegado: todo entra por PR») y
`AGENTS.md:244-246` («los permisos de la sesión lo deniegan… `AYR_OWNER_PUSH=1` queda para el
dueño»). Pero `.claude/settings.json:18` tiene en **`allow`**
`"Bash(AYR_OWNER_PUSH=1 git push origin main)"`, y el `deny` (`:108-129`) solo cubre `+main`,
`:main`, `--force`, `-f`, `--delete` y `-d`. El `settings.json` del checkout principal es igual en
esas líneas, y su `settings.local.json` no menciona `push`.
**Escenario:** una sesión futura confía en que el `deny` la frena y prueba `AYR_OWNER_PUSH=1 git
push origin main` (por ejemplo para un cierre de docs): el permiso lo deja pasar sin preguntar y
el hook también, porque lleva la variable. La regla escrita es una red que no existe.
**Arreglo:** que el dueño saque esa línea de `allow` y agregue a `deny`
`Bash(*git push origin main*)` / `Bash(*git push * main)` (cambio de configuración: lo hace el
dueño, no el agente). Mientras tanto, que el texto diga «prohibido por regla» y no «los permisos lo
deniegan».

### A-2 — P2 — La regla 1 nueva («ninguna acción pide confirmación») choca con el resto de AGENTS.md, que no se tocó

`AGENTS.md:97-106` (primer párrafo de la regla 1: push, merge, deploy, comandos contra Neon
`production` y escrituras en `production` → «propone el comando exacto y se detiene a esperar el OK
explícito del dueño, vía las reglas `ask`», con `ask` hoy vacío), `AGENTS.md:135` (regla 5:
`--execute --confirm-production` «exige aprobación explícita del dueño»), `AGENTS.md:224-227`
(§3.1: `migrate deploy`, `migrate diff`, `db:prod` → «espera el OK explícito del dueño por cada
uno… una autorización de ventana no permite encadenarlos»), `AGENTS.md:256` y `:271` (respaldos y
escrituras masivas con OK por nombre / aprobación explícita), §3.3 (borrar ramas Neon «solo con su
OK por nombre», cuando D-445 lo pone en `deny`).
**Escenario:** el párrafo nuevo dice que «los demás comandos que antes estaban en `ask` corren sin
OK por acción»; `db:prod` y los `--execute --confirm-production` estaban en `ask`. Una sesión que
lee la regla 1 entiende que puede correrlos; una que lee §3.1 o la regla 5, que no. Con datos
reales, la ambigüedad está en el lugar más caro. D-445 en `ARQUITECTURA.md` §0.2 tampoco aclara
las escrituras masivas contra producción.
**Arreglo:** decisión del dueño (D-230): o D-445 excluye en texto `db:prod`, `migrate *`,
`--execute --confirm-production` y los borrados por nombre, o esas reglas se reescriben. Hasta
entonces, que la regla 1 diga explícitamente cuáles de esas siguen pidiendo el OK, y que el primer
párrafo de la regla 1 avise que D-445 lo reemplaza.

### A-3 — P2 — Vista previa de «Ejecutar y cerrar» con 20 s: un borrador grande puede quedarse sin cierre por ese botón

`apps/api/src/production/close-preview.ts:31` (`PREVIEW_TIMEOUT_MS = 20_000`) y `:156-158`. La
vista previa corre el `commitInTx` **entero** (`roofing-drafts.service.ts:251-253`), el mismo
trabajo al que el commit real le da 120 s (`roofing-drafts.service.ts:234`) para hasta
`MAX_DRAFT_ROWS = 50` filas (`:60`). El propio comentario lo admite: «no puede durar lo que dura un
borrador de 50 filas: a los 20 s se corta». PROGRESO registró antes unos 2,4 s por fila contra
Neon para este mismo tipo de lote (sección del `MAX_BATCH_ROWS`, 50 → 20). **No hay medida en
cc28** de cuánto tarda hoy una vista previa de N filas contra Neon.
**Escenario:** planta carga 15–50 filas y pulsa «Ejecutar y cerrar». El web exige la vista previa
antes de ejecutar (`roofing-order-panel.tsx:495-501`); a los 20 s Prisma corta con `P2028`, que
no se traduce en ningún filtro y llega como 500 «No se pudo…». El botón queda inútil para ese
borrador; la salida existe (Ejecutar sin cerrar y después «Cerrar sin reportar más»), pero nadie se
la dice al usuario. Antes de cc28 esa misma vista previa tenía 120 s.
**Arreglo:** medir la vista previa con 20 y 50 filas contra demo antes del deploy. Si no entra,
escalar el tope con las filas, como `mountCoil` (`30_000 + 3_000 × n`), o volver a 120 s y
resolver SM-8 por otro lado (por ejemplo, `lock_timeout` corto dentro de la vista previa para
fallar rápido **esperando**, no **trabajando**). En cualquier caso, traducir `P2028` de la vista
previa a un 409/503 legible que nombre la salida.

### A-4 — P3 — La relectura bajo el bloqueo en `cancel` ya no puede dispararse

`apps/api/src/cutting/cutting.service.ts:639-650`. Con `receive` y `reverse` tomando ahora
`cutting_orders` primero, y siendo esas tres las únicas que escriben el estado de las filas,
`cancel` lee `order.coils` (`:613-616`) **después** de tener la orden: en READ COMMITTED esa
lectura ya ve el último estado confirmado y nadie puede cambiarlo mientras tanto. El 409 de
«La orden cambió mientras se anulaba» queda inalcanzable. El test de contrato
(`lock-order.contract.spec.ts`, «una fila que dejó de estar SENT bajo el lock aborta con 409») lo
cubre solo con un doble.
**Escenario:** sin daño. El riesgo es que alguien crea que ese 409 es la protección real y un
camino nuevo que escriba filas sin tomar la orden quede tapado por un test que pasa igual.
**Arreglo:** dejarlo como defensa, pero decir en el comentario que la garantía la da el bloqueo de
la orden, y que todo escritor nuevo de `cutting_order_coils` tiene que tomarla primero.

### A-5 — P3 — El par concurrente de corte alterna el orden y con eso le quita su fuerza a `okByOp`

`apps/api/src/inventory/lock-order.db-spec.ts:829` (`i % 2 === 0 ? ops : [...ops].reverse()`)
frente a `race` (`:424-428`) y `expectClean` (`:452-455`). `okByOp` cuenta éxitos **por posición**,
no por operación. Al invertir el arreglo en las iteraciones impares, la posición 0 es `receive` en
unas y `cancel` en otras.
**Escenario:** si `receive` ganara siempre (por ejemplo, una fixture que hace fallar `cancel` con
un 400 en todas las corridas), `okByOp[0]` y `okByOp[1]` saldrían los dos > 0 y `expectClean` daría
verde. Es exactamente el caso que la autorrevisión P2-2 de cc18 quiso cerrar con `okByOp`.
**Arreglo:** contar por nombre de operación (pasar `[{ name, run }]` a `race`) o, sin cambiar el
helper, verificar al final de la prueba que hubo al menos una fila `RECEIVED` y una `CANCELLED`
entre las iteraciones.

### A-6 — P3 — La prueba de «la vista previa no retiene bloqueos» no prueba eso

`apps/api/src/inventory/lock-order.db-spec.ts`, «un cierre real a la vez que una vista previa entra
en cuanto esta termina». Con el lanzamiento simultáneo, quién toma la orden primero no está
controlado; la aserción `Date.now() - started < PREVIEW_TIMEOUT_MS` se cumple con cualquier vista
previa que termine, y que una transacción suelte sus bloqueos al terminar es propio de Postgres, no
del código. Ninguna aserción distingue «la vista previa fue primera y el cierre esperó» de «el
cierre fue primero».
**Escenario:** la prueba queda verde aunque SM-8 (vista previa retenida mucho tiempo) vuelva.
**Arreglo:** forzar el orden (que la vista previa haga una pausa después de `lockOrder`, como las
pausas `PAUSE_MS` de los otros pares) y afirmar que el cierre esperó y terminó; o renombrar la
prueba a lo que prueba: «un cierre real concurrente no falla por la vista previa».

### A-7 — P3 — A-6 de cc27 queda cerrado solo a medias: el «antes» de las bobinas se lee sin bloquearlas

`apps/api/src/production/close-preview.ts:89-109`. El `lockOrder` nuevo (`:89`) bloquea solo la
orden de producción; `coilStates` (`:106`) lee saldos y estados de las bobinas montadas **antes**
de que `run` tome bobinas y saldos (`:109`). Un movimiento que no pasa por esta orden —la orden hermana del
mismo pedido consumiendo la misma bobina, un partido o un ajuste— puede entrar entre las dos
lecturas.
**Escenario:** la vista previa muestra como consumo de este cierre kilos que consumió otra orden.
Es solo la pantalla de confirmación (todo se deshace), pero es el error que A-6 describía.
**Arreglo:** tomar las bobinas montadas con `inventory.lockInOrder(tx, { coilIds })` antes de
`coilStates`, con el mismo conjunto que tomará la acción, para no ampliarlo fuera de orden
(D-386). Si no se hace, que PROGRESO diga que A-6 quedó parcial.

### A-8 — P3 — `env:demo` desde un worktree imprime un mensaje recortado

`scripts/env-demo.mjs:19-23`: `howToFix.replace(/^Falta [^.]+\.\s*/, '')`. La ruta siempre
contiene un punto antes de su fin (`…\ayr-steel-erp\.env.demo`), así que `[^.]+\.` corta en el
punto de `.env` y deja «pnpm env:demo no corre desde un worktree. env.demo. El .env.demo se genera
una sola vez…».
**Escenario:** mensaje confuso, sin otro efecto.
**Arreglo:** que `demoEnvPlan` devuelva por separado `missing` y `howToFix` (sin el «Falta…»), o
armar el mensaje de `env-demo` sin regex.

### A-9 — P3 — `mainCheckoutRoot` falla abierto si git no responde, y compara rutas sensible a mayúsculas

`scripts/demo-env-path.mjs:15-22` y `:40`. (a) Si `git` falta, si no es un repo o si es anterior
a 2.31 (`--path-format` no existe), devuelve `root`: desde un worktree, `inWorktree` sale `false`,
`canGenerate` `true`, y `dev:demo`/`env:demo` vuelven a generar un `.env.demo` **dentro del
worktree**, que es el caso que M4 quiere impedir. Aquí `git` es 2.42, así que hoy no pasa. (b)
`resolve(root) !== resolve(mainRoot)` compara texto: en Windows, una unidad `c:` frente a `C:` (git
devuelve `C:/…`; `ROOT` sale de `import.meta.url`) marcaría al checkout principal como worktree, y
`env:demo` se negaría a correr allí (falla cerrado).
**Arreglo:** (a) si `git` falla, `canGenerate: false` con un mensaje que lo diga; o, además, mirar
si `root/.git` es un archivo (worktree) o una carpeta. (b) Comparar en Windows con
`toLowerCase()` o con `realpathSync.native`.

### A-10 — P3 — `AYR_ENV_DEMO` relativo se resuelve contra el cwd del proceso

`scripts/demo-env-path.mjs:41` (`resolve(env.AYR_ENV_DEMO)`). Con `pnpm` en la raíz es la raíz del
árbol donde corre, que en un worktree es el worktree: `AYR_ENV_DEMO=.env.demo` desde un worktree
apunta al del worktree, no al del checkout principal. `canGenerate` sigue en `false`, así que no se
genera nada, pero el mensaje y el comportamiento sorprenden.
**Arreglo:** documentar «ruta absoluta» o resolverla contra `mainRoot`.

### A-11 — P3 — Rótulo del Panel del vendedor sin la precisión de D-459

`apps/web/src/app/(app)/seller-sales-card.tsx:63`: «N de M cotizaciones emitidas … tienen
pedido.» Desde D-459, una cotización cuyo único pedido se anuló no cuenta, y el vendedor que la ve
confirmada en su lista puede creer que la cifra está mal.
**Arreglo:** «tienen un pedido vigente» (o «no anulado»), con el E2E ajustado al texto.

### A-12 — P3 — La regla 17 no dice el orden _dentro_ de los documentos que M1 acaba de fijar

`AGENTS.md:185-194`. La regla da el orden documentos → reservas → bobinas → saldos, pero el
arreglo de M1 depende de un orden **entre documentos**: la orden de corte antes que sus filas
(`cutting_orders` → `cutting_order_coils`). §3.3.1 de ARQUITECTURA nombra pares (OP → pedido,
despacho → pedido) y no este.
**Escenario:** un camino nuevo de corte toma la fila primero «porque la regla no dice nada» y
reabre el deadlock que M1 cerró.
**Arreglo:** agregar en la regla 17 (o en §3.3.1) «un documento antes que sus filas hijas (orden de
corte → `cutting_order_coils`)».

## Conteo

| Severidad | Cantidad | Ids                                            |
| --------- | -------- | ---------------------------------------------- |
| P0        | 0        | —                                              |
| P1        | 0        | —                                              |
| P2        | 3        | A-1, A-2, A-3                                  |
| P3        | 9        | A-4, A-5, A-6, A-7, A-8, A-9, A-10, A-11, A-12 |

## Resolución (sesión cc28, corte 1)

- **A-1 (P2), corregido en el texto:** AGENTS.md ya no atribuye a los permisos de la sesión que el
  agente no empuje a `main`; es decisión del dueño (D-460). Endurecer `.claude/settings.json` es
  decisión del dueño.
- **A-2 (P2), corregido:** D-460 deja explícitas las tres acciones que siguen pidiendo OK por nombre
  (migración, `--execute --confirm-production`, borrar rama de Neon); el primer párrafo de la regla 1
  y §3.1 quedan alineados con D-445.
- **A-3 (P2), corregido:** la vista previa usa el tope de su acción real (120 s el borrador, 60 s los
  cierres), igual que SM-1 del segundo modelo.
- **A-8, A-9, A-10, A-11, A-12 (P3), corregidos:** mensaje de `env:demo`, `mainCheckoutRoot` sin
  fallar abierto y con rutas sin distinción de mayúsculas en Windows, `AYR_ENV_DEMO` relativo desde
  el checkout principal, rótulo «pedido vigente», y la regla 17 dice que el documento va antes que
  sus filas.
- **A-4, A-5, A-6, A-7 (P3):** en PROGRESO.
