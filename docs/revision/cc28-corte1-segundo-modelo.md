# cc28, corte 1 — revisión de segundo modelo

Revisión de un **segundo modelo (Sonnet, contexto limpio)**. **No es una revisión humana** ni sustituye la del dueño al cierre; no da por independiente ningún pase anterior (AGENTS.md §2.2).

## Alcance

`git diff origin/main...HEAD` de la rama `cc28-limpieza` (18 archivos):

- Orden de bloqueos de la orden de corte: `receive`, `reverse` y `cancel` (`apps/api/src/cutting/cutting.service.ts`) y su contrato (`lock-order.contract.spec.ts`).
- Panel del vendedor: la conversión excluye pedidos anulados (`seller-dashboard.service.ts`, D-459) y su E2E.
- Vista previa del cierre de planta: bloqueo de la orden primero y tope de 20 s (`close-preview.ts`).
- Pruebas contra la base nuevas (`lock-order.db-spec.ts`).
- Esquema `.strict()` del ítem de mostrador (`packages/shared/src/schemas/pos.ts`).
- Ediciones de `AGENTS.md` y filas de `docs/ARQUITECTURA.md`.
- Scripts de entorno demo (`scripts/demo-env-path.mjs` y sus tres llamadores).

Comprobado: los unitarios de `lock-order.contract`, `close-preview` y `pos-math` pasan (37 pruebas) y `pnpm test:scripts` pasa (52). No se corrieron pruebas contra la base, E2E ni compilaciones.

Verificado sin hallazgo:

- Orden de bloqueos de corte. Los tres métodos toman orden → fila(s) → bobina(s)/saldos, consistente con la regla 17. El único otro escritor de `cutting_order_coils` (`send`, línea 174) crea filas de una orden nueva, así que no hay inversión nueva.
- Conversión del vendedor. `SalesOrderStatus.CANCELLED` existe y `quotationSellerWhere` no define `salesOrders`, así que el filtro no pisa nada.
- `.strict()` del ítem POS. El web (`pos-view.tsx`, `posLinePayload`) solo manda `productId`, `qty` y un precio, y los helpers E2E (`e2e/helpers/pos.ts`) solo `productId`, `qty` y `unitPricePen`. No hay regresión para llamadores existentes. `.strict()` va antes de `.refine`, así que el esquema sigue siendo válido.
- Demo env. Ninguna ruta imprime secretos; solo viajan rutas. `AYR_ENV_DEMO` lo fija el operador (no es entrada de red), así que no hay traversal explotable.

## Hallazgos

### SM-1 — P2 — La vista previa se corta a 20 s mientras el cierre real admite 120 s

`apps/api/src/production/close-preview.ts:158` (`PREVIEW_TIMEOUT_MS = 20_000`) frente a `roofing-drafts.service.ts:234` (`commit`: `timeout: 120_000`).

**Escenario:** la vista previa ejecuta el cuerpo entero del cierre (`commitInTx`) dentro de su transacción. Un borrador grande (el propio comentario habla de 50 filas) o una máquina con latencia a Neon tarda más de 20 s. Prisma cierra la transacción interactiva y lanza `P2028`. Ese error no se atiende en ningún filtro: el único rastro es el comentario de `roofing-production.service.ts:578`, que ya describe ese 500 intermitente. El usuario recibe un 500 al pedir la vista previa justo en los cierres grandes, donde más hace falta. Además la vista previa falla aunque el cierre real habría entrado en 60 s. El test de `db-spec` mide solo una orden mínima, así que no lo ve.

**Arreglo:** dimensionar el tope como el de montar (`30_000 + 3_000 × bobinas`) o subirlo a 60 s. O bien capturar `P2028` en `previewPlantClose` y devolver un 409/422 con texto claro («la vista previa tardó demasiado; ejecuta el cierre directamente»). Agregar una prueba con un borrador de muchas filas, o al menos de la rama de `P2028`.

### SM-2 — P2 — `AGENTS.md` se contradice: la regla 1, §3.1 y §9 siguen describiendo el régimen de `ask`

`AGENTS.md:96-107` (párrafo introductorio de la regla 1), el último punto de §3.1 y la fila `.claude/settings.json` de la tabla §9.

**Escenario:** el párrafo nuevo de D-445 dice «ninguna acción pide confirmación» y que el push directo a `main` está denegado. Pero el párrafo que lo antecede sigue diciendo que push, merge, deploy, comandos contra Neon `production` y borrados exigen detenerse a esperar el OK vía las reglas `ask`, y que «Push a `main` sigue exigiendo además `AYR_OWNER_PUSH=1`». El último punto de §3.1 dice lo mismo de `migrate deploy`, `migrate diff` y `db:prod`, y la tabla §9 describe `.claude/settings.json` como «`ask` técnico». Hoy `"ask": []` (`.claude/settings.json:130`). Un agente que lea de arriba abajo encuentra dos reglas incompatibles en el mismo ítem. El archivo se declara canónico y «manda» ante la duda, así que la ambigüedad es costosa.

**Arreglo:** reescribir el párrafo inicial de la regla 1 como histórico o marcarlo explícitamente «sustituido por D-445 salvo lo que sigue». Ajustar §3.1 (`migrate`/`db:prod` corren sin OK por acción, salvo la regla «una migración detiene la sesión») y §9.

### SM-3 — P3 — La relectura nueva de `cancel` es código inalcanzable y su prueba no demuestra lo que dice

`apps/api/src/cutting/cutting.service.ts:639-650` y `lock-order.contract.spec.ts` (caso «una fila que dejó de estar SENT bajo el lock aborta con 409»).

**Escenario:** `cancel` ya tiene la orden bloqueada (`lockCuttingOrder`). Los únicos escritores de `cutting_order_coils` (`receive`:351, `reverse`:548, `cancel`:653) toman ese mismo bloqueo antes. `send` solo crea filas de una orden nueva. Mientras `cancel` retiene la orden, ninguna fila puede cambiar, así que el `ConflictException` nunca se dispara. El test lo ejercita con un mock que devuelve `RECEIVED`, un estado que la base no puede producir ahí. Es defensa en profundidad inofensiva. Pero el título de PROGRESO/ARQUITECTURA («releer bajo el lock») sugiere que arregla una carrera que en realidad cierra el bloqueo de la orden, y el texto «vuelve a cargarla» describe algo que no ocurre.

**Arreglo:** dejarlo y decir en el comentario que es redundante con el bloqueo de la orden, o quitarlo. No atribuir a la relectura el cierre de P2-1.

### SM-4 — P3 — Las pruebas `db-spec` nuevas dependen del azar y no cubren todos los cruces tocados

`apps/api/src/inventory/lock-order.db-spec.ts`, bloques cc28.

- El par `receive × cancel` exige `okByOp > 0` por posición (`expectClean`). Depende de que, alternando el orden de arranque, cada operación gane alguna vez. Con `LOCK_ORDER_ITERATIONS=1` falla siempre. Además no hay pausa forzada sobre `lockCuttingOrder` (la pausa existente espía `lockCoilRows`/`lockBalance`), así que el cruce depende de la ventana natural.
- La regla 17 de `AGENTS.md` dice «un camino nuevo que mueva inventario suma su par ahí». `reverse` cambió de orden y no tiene par (falta `reverse × cancel` o `reverse × receive`); solo lo cubre el contrato con mocks.
- La prueba «un cierre real a la vez que una vista previa» acepta cualquier `HttpException` de la vista previa, así que una vista previa rota por otro motivo da verde. La de «no deja nada» compara conteos globales de `audit_log`, `inventory_movements` e `idempotency_keys`, que dan falso rojo si algo más escribe en la base de pruebas durante la corrida.

**Arreglo:** agregar el par de `reverse`. Fijar con una pausa (o `pg_sleep`) quién gana y probar ambos órdenes de forma determinista. Acotar los conteos a la orden/actor de la prueba. Afirmar el código del rechazo de la vista previa tardía.

### SM-5 — P3 — D-457 y el web siguen diciendo «aunque después se haya anulado»

`docs/ARQUITECTURA.md` fila D-457 («cuántas tienen pedido (cualquiera, aunque después se haya anulado)») y `apps/web/src/app/(app)/seller-sales-card.tsx:63` («cotizaciones emitidas … tienen pedido»).

**Escenario:** D-459 cambia la regla, pero la fila D-457 sigue afirmando lo contrario sin remitir a D-459. El texto del Panel también es impreciso: una cotización con pedido anulado «tiene pedido» y no cuenta. Un vendedor que ve «1 de 3 … tienen pedido» no entiende por qué la cuenta no coincide con su lista.

**Arreglo:** anotar «(precisado por D-459)» en D-457 y cambiar el texto a «tienen un pedido vigente».

### SM-6 — P3 — Mensaje de error de `env:demo` mal recortado

`scripts/env-demo.mjs:21` (`plan.howToFix.replace(/^Falta [^.]+\.\s*/, '')`).

**Escenario:** `howToFix` empieza con `Falta <ruta>.`, y la ruta contiene `.env.demo`. El patrón `[^.]+` se detiene en el primer punto de la ruta, así que el mensaje sale como «pnpm env:demo no corre desde un worktree. env.demo. El .env.demo se genera una sola vez…», con un fragmento basura. Además el texto dice «desde un worktree» también cuando la causa es que `AYR_ENV_DEMO` apunta dentro de uno.

**Arreglo:** exponer el motivo por separado en `demoEnvPlan` (por ejemplo `howToFixBody`) en vez de recortar con una expresión regular. Añadir una prueba del mensaje.

### SM-7 — P3 — La detección de worktree falla abierta y no tiene prueba propia

`scripts/demo-env-path.mjs:17-24` (`mainCheckoutRoot`), `scripts/demo-env-path.test.mjs`.

**Escenario:**

- Si `git` no responde (no está en el PATH, o `safe.directory`), `mainCheckoutRoot` devuelve `root` y `inWorktree` pasa a `false`. Un worktree vuelve a poder generar su propio `.env.demo`, que es exactamente el defecto que el cambio quiere evitar, y sin aviso.
- En Windows, `git --path-format=absolute` devuelve `C:/…` y `ROOT` sale de `fileURLToPath`. Una diferencia de mayúsculas en la letra de unidad, o un alias 8.3 o junction, haría que `resolve(root) !== resolve(mainRoot)` en el checkout principal. Ahí `env:demo` se negaría a correr en el lugar correcto.
- Las pruebas cubren solo la función pura. `mainCheckoutRoot` no se prueba, y que los tres scripts respeten `canGenerate` se «prueba» con una expresión regular sobre su texto.

**Arreglo:** fallar cerrado si `git rev-parse` falla (error, no `root`). Comparar rutas normalizadas (`toLowerCase` en `win32`, `realpathSync`). Añadir una prueba de `mainCheckoutRoot` con un worktree temporal.

### SM-8 — P3 — Tras rotar la contraseña de la rama demo, `.env.demo` queda viejo y la ayuda no sirve desde un worktree

`scripts/dev-demo.mjs:35`, `scripts/env-demo.mjs:19`.

**Escenario:** `db-reset-dev` rota la contraseña de la rama `demo`, y `.env.demo` guarda `DATABASE_URL`/`DIRECT_URL` con ella. Regenerarlos requiere `pnpm env:demo`. Ahora ese comando se niega desde un worktree. `dev:demo` sigue indicando «Corré pnpm env:demo» ante un archivo incompleto, y desde el worktree esa instrucción falla. El único camino es abrir el checkout principal.

**Arreglo:** que el mensaje de `dev:demo`/`db:demo` diga «corre `pnpm env:demo` en el checkout principal». Alternativa: permitir en un worktree la regeneración cuando el destino ya existe en el principal (solo reusa secretos).

### SM-9 — P3 — `.strict()` solo en el ítem; el resto del cuerpo POS sigue descartando campos desconocidos

`packages/shared/src/schemas/pos.ts:225` (`createPosSaleSchema` no es estricto).

**Escenario:** el motivo declarado de A-2 (un campo desconocido no debe caer en silencio a un valor por defecto) vale igual para `forceGenericCustomer`, `method` o `customerId` mal escritos. Un campo de cabecera nuevo que un web más reciente mande a un API viejo se descarta sin error. Es la misma clase de defecto en otra capa, de menor daño (el dinero está en el ítem).

**Arreglo:** decidir si la cabecera también es `.strict()`. Si no, anotar por qué no.

## Conteo

| Severidad | Cantidad                                     |
| --------- | -------------------------------------------- |
| P0        | 0                                            |
| P1        | 0                                            |
| P2        | 2 (SM-1, SM-2)                               |
| P3        | 7 (SM-3, SM-4, SM-5, SM-6, SM-7, SM-8, SM-9) |

Esta es una **revisión de un modelo, no de una persona**: no sustituye la revisión del dueño al cierre ni da por independiente ningún pase anterior (AGENTS.md §2.2).

## Resolución (sesión cc28, corte 1)

- **SM-1 (P2), corregido:** la vista previa usa el tope de su acción real (120 s / 60 s).
- **SM-2 (P2), corregido:** AGENTS.md alineado con D-445 en la regla 1, §3.1 y §9 (y D-460 para lo
  que sigue pidiendo OK).
- **SM-5, SM-6, SM-7 (P3), corregidos:** rótulo «pedido vigente», mensaje de `env:demo`, y
  `mainCheckoutRoot` sin fallar abierto ni distinguir mayúsculas en Windows.
- **SM-3, SM-4, SM-8, SM-9 (P3):** en PROGRESO.
