# Autorrevisión — no vale como pase cruzado

Corte A de cc49 (D-636), rama `cc49-a-version`, `git diff origin/main...HEAD` (3 commits:
f36a361d, 3da8ca8d, 3fa98aeb). Revisor: subagente que no escribió el cambio ni leyó el handoff de
implementación. Solo lectura. Esto es una lista de riesgos, no una aprobación.

## Lo verificado (sin hallazgo)

- **El sha queda inlined en el build.** `apps/web/.next` del worktree (compilado a las 15:28) tiene
  en el chunk de `/version` `AYR_BUILD_SHA: ("TURBOPACK compile-time value", "")` y
  `AYR_BUILT_AT: ("TURBOPACK compile-time value", "2026-10-12T20:27:38.412Z")`. Ese build es de
  Turbopack; el de Vercel (`next build`, webpack) usa DefinePlugin para `next.config#env` con la
  misma referencia literal `process.env.AYR_BUILD_SHA`. **No lo verifiqué con un build webpack.**
- **Turbo.** `VERCEL_GIT_COMMIT_SHA` en `tasks.build.env` hace dos cosas necesarias: en modo
  estricto la deja pasar al proceso de `next build`, y entra en el hash, así que un commit nuevo
  (también uno solo de docs, cuyo build de la web antes podía salir de caché con el `.next` y el
  sha viejos) es cache miss. Correcto.
- **Vercel no ignora commits de docs**: según `local-data/cc49/vercel-diagnostico.md`, `4cc9fc21`
  (docs cc48) se desplegó a los 34 s. No hay `vercel.json` ni `ignoreCommand` en el repo. Que
  `VERCEL_GIT_COMMIT_SHA` esté disponible en el build depende de «exponer variables de sistema»
  en el proyecto de Vercel (activo por defecto); **no verificado** desde aquí.
- **Middleware.** `OPEN_PATHS.includes(pathname)` es igualdad exacta: `/version/x`, `/versionx`,
  `/VERSION` y `/%76ersion` siguen el camino normal (redirigen a `/login` sin sesión). La barra
  final la normaliza Next con 308 antes. `/version` no entra en `PUBLIC_PATHS`, así que con sesión
  no redirige a `/`. Lo leí; no hay test que lo pruebe (ver P3-3).
- **Comparador.** `shaMatches` exige 7–40 hex a los dos lados y prefijo en cualquier sentido; con
  `origin/main` (40) contra Vercel (40) es igualdad exacta. «dev», vacío, `null` nunca coinciden.
  No encontré falso verde realista (una colisión de prefijo de 7+ hex entre commits del repo es
  despreciable).
- **Un dominio que no responde** cuenta como «todavía no», agota el tope y suma una falla con
  dominio, esperado y publicado; el smoke sigue y termina con `exit 1`. La espera ocurre **antes**
  de crear el admin efímero (línea 166), así que no queda vivo durante la espera.
- **`deploy-api.mjs`.** `expectedEnvNames` sale de `Object.keys(ENV_VARS)`, así que `GIT_SHA`
  entra solo en la verificación de nombres; coherente. `GIT_SHA` = `gitSha` = el mismo valor del
  label `git-sha`.
- **Node fetch con `cache: 'no-store'`**: probado con Node v24.12.0 (`fetchShaField` contra una
  URL `data:`), no lanza.
- **Tests.** `node --test scripts/smoke-version.test.mjs`: 9/9 en verde (corrido aquí); está en la
  CI vía `pnpm test:scripts` (`ci.yml:36`). `health.controller.spec.ts` entra por el `testRegex`
  de jest y `build-info.spec.ts` por el `include` de vitest. No corrí jest, vitest ni el E2E.
- **Exposición.** `/version` publica solo `sha` y `builtAt`; `/api/health` suma `sha` a `uptime`,
  que ya era público. El valor viene de `next.config#env` y solo lo referencia el route handler:
  no llega al bundle del cliente. Sin secretos.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2-1 — Falso rojo si `main` avanza durante la espera o hay otra pieza en curso, y un rojo dispara la vuelta atrás

- **Dónde:** `scripts/smoke-prod.mjs:50-54` (esperado = `origin/main` leído una vez al inicio) y
  `scripts/smoke-version.mjs:26` (`shaMatches` exige el mismo commit).
- **Escenario:** la sesión A mergea, corre `smoke:prod` sin `--expect-sha`, y la sesión B mergea
  durante los 10 minutos de espera. Vercel publica el commit de B, que nunca coincide con el
  `origin/main` que A leyó: A falla tras 10 min por dominio. El caso inverso también existe:
  A corre el smoke después del merge de B mientras el build de B está en curso o falla, y A falla
  por un despliegue que no es suyo. Según AGENTS.md §3 regla 1, un smoke rojo lleva a la vuelta
  atrás automática (API a la revisión anterior y revert del merge) de la pieza equivocada.
- **Propuesta:** aceptar como «publicado» un commit que sea el esperado **o un descendiente** suyo
  (`git merge-base --is-ancestor <esperado> <publicado>` después de un `git fetch`), y que el
  cierre pase siempre `--expect-sha <sha del merge de su PR>` en vez de depender de
  `origin/main`. Como mínimo, documentarlo en la skill de cierre: con otra sesión mergeando en
  paralelo, el rojo de `/version` no es por sí solo motivo de vuelta atrás.

### P2-2 — Un tope de 10 min es corto frente a lo ya medido, y su rojo dispara la vuelta atrás

- **Dónde:** `scripts/smoke-version.mjs:8` (`VERSION_TIMEOUT_MS`).
- **Escenario:** el diagnóstico de cc48 mide `/login` cambiando unos 6 min después del merge. Con
  un build en cola (un preview concurrente, o Vercel lento) se pasa de 10 min: falso rojo y
  vuelta atrás automática de una entrega sana. Además el segundo dominio espera aparte otros 10
  min si el primero agotó el tope (peor caso unos 20 min).
- **Propuesta:** distinguir «el despliegue todavía no publica» (`/version` dice el commit
  anterior) de «el despliegue publicado está mal»; en el primer caso, que la falla diga
  «despliegue sin publicar todavía, no revertir: reintentar el smoke» y que la skill de
  cierre/ventana lo trate como bloqueo y no como rojo del producto. O subir el tope (p. ej. 20 min)
  y que, si el primer dominio agotó el tope, el segundo haga un solo intento.

### P3-1 — `fetch` sin timeout: la espera puede pasar el tope

- **Dónde:** `scripts/smoke-version.mjs:86` (`fetchShaField`).
- **Escenario:** una conexión que acepta y no responde queda colgada hasta el `headersTimeout`
  de undici (300 s); el tope se mira recién al volver. Un intento lanzado al minuto 9:59 puede
  llevar la espera a unos 15 min por dominio. No da falso verde. Deducido del código y del
  comportamiento por defecto de undici; no lo reproduje.
- **Propuesta:** `signal: AbortSignal.timeout(10_000)` en el `fetch`.

### P3-2 — Nada automatizado prueba que el sha real llegue al bundle de producción

- **Dónde:** `apps/web/src/lib/build-info.spec.ts` y `e2e/tests/version-d636.spec.ts:21`.
- **Escenario:** el unitario prueba `buildInfo` con valores a mano, y el E2E local o de la CI
  espera «dev». Si el inlining fallara (`process.env.AYR_BUILD_SHA` sin definir en runtime), el
  resultado también sería «dev»: los tests pasan igual. El primer aviso sería el primer
  `smoke:prod` en rojo, que hoy lleva a la vuelta atrás. El modo de falla es seguro (rojo, nunca
  verde), pero caro.
- **Propuesta:** un paso de CI que compile la web con `VERCEL_GIT_COMMIT_SHA=<sha de prueba>` y
  busque ese valor en el bundle de `/version`, o que el primer deploy de D-636 trate un «dev» en
  `/version` como fallo de configuración y no como motivo de revertir.

### P3-3 — Sin test de que `/version` no abre otras rutas

- **Dónde:** `apps/web/src/middleware.ts:18`; `e2e/tests/version-d636.spec.ts`.
- **Escenario:** si alguien cambia el `includes` por un `startsWith` (como en `PUBLIC_PATHS`),
  `/version*` queda abierto sin sesión y ningún test lo detecta. El test «con sesión» también
  pasaría sin `OPEN_PATHS`: con sesión y ruta no pública el middleware ya devolvía `next()`; solo
  protege de meterla en `PUBLIC_PATHS`.
- **Propuesta:** en el E2E sin sesión, `GET /version/x` y `GET /versionx` con `maxRedirects: 0`
  esperando 307/308 a `/login`.

### P3-4 — El E2E dice que «puede correr contra cualquier entorno»

- **Dónde:** `e2e/tests/version-d636.spec.ts:9-11` y ramas `isProduction`.
- **Escenario:** el test «con sesión» hace login por la UI con `adminCredentials()`. Contra
  producción (`E2E_BASE_URL`) eso usaría credenciales reales, contra D-126 y la regla de no usar la
  cuenta del dueño; y `e2e:prod` está en `deny`. La rama de producción nunca va a correr.
- **Propuesta:** quitar la rama `isProduction` y la frase, o saltar el spec con `E2E_BASE_URL`.

### P3-5 — `--expect-api-sha` tras una vuelta atrás a una revisión anterior a D-636

- **Dónde:** docs (AGENTS.md §3.2, `ayr-ventana` paso 8); `apps/api/src/health/health.controller.ts:11`.
- **Escenario:** si se vuelve con `update-traffic` a una revisión desplegada antes de D-636, esa
  revisión no tiene `GIT_SHA` y `/api/health` dice «dev»: un smoke con `--expect-api-sha` falla
  10 min y el mensaje no explica por qué.
- **Propuesta:** una línea en la skill de ventana: tras una vuelta atrás a una revisión sin
  `GIT_SHA`, el smoke va sin `--expect-api-sha` y la API se verifica por el label. Opcional: que
  la espera de la API, que se despliega de forma síncrona, sea un solo intento.

### P3-6 — `env` de turbo en todas las tareas `build`

- **Dónde:** `turbo.json:24`.
- **Escenario:** en Vercel, `@ayr/shared` (y la API si entra en el grafo) pierde la caché en cada
  commit, aunque solo la web lee la variable. Solo cuesta tiempo de build, no cambia el resultado.
- **Propuesta:** declararla en `"@ayr/web#build"` (o el nombre del paquete web) en vez de en
  `build`. Verificar antes el nombre del paquete.

### P3-7 — `--expect-sha=<sha>` se ignora en silencio

- **Dónde:** `scripts/smoke-version.mjs:30` (`argv.indexOf(flag)`).
- **Escenario:** con la forma `--expect-sha=abc1234` no encuentra la bandera, devuelve `null` y el
  smoke usa `origin/main` sin avisar. Lo mismo con `--expect-api-sha=…`, que entonces no compara
  la API.
- **Propuesta:** aceptar también `flag=valor`, o rechazar cualquier argumento que empiece con
  `--expect` y no sea exactamente la bandera.

## Lo que no verifiqué

- Que un `next build` webpack inline el valor (solo vi la salida de Turbopack).
- Que el proyecto de Vercel exponga `VERCEL_GIT_COMMIT_SHA` en el build, y si construye con
  `turbo run build` o con `next build` directo.
- Las corridas de jest (API), vitest (web) y Playwright de este corte.
