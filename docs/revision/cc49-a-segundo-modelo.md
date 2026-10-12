# Revisión del corte A de cc49 (D-636) — segundo modelo

Alcance: `git diff origin/main...HEAD` (17 archivos). Solo lectura; no se corrió nada contra producción.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2

**P2-1. `fetch` sin tope de tiempo: el límite de 10 min no se cumple si una conexión se cuelga.**
`scripts/smoke-version.mjs:84-90` (`fetchShaField`) y `waitForSha` (`:58-72`). `waitForSha` solo compara el reloj _entre_ intentos; un `fetch` que no responde (Vercel o Cloud Run frío, TCP colgado) se queda esperando sin límite, y el smoke queda parado en producción antes de crear el admin efímero (no deja basura, pero sí un cierre bloqueado). Un `fetch` de Node no tiene timeout propio útil para una conexión que acepta y no contesta.
Propuesta: `signal: AbortSignal.timeout(10_000)` en el `fetch` de `fetchShaField` (el error cae en el `catch` de `waitForSha` y cuenta como «todavía no»). Sumar un test con un `fetchImpl` que respete `signal`.

**P2-2. Falso rojo posible por `origin/main` más nuevo que lo desplegado.**
`scripts/smoke-prod.mjs:48-54`. El esperado por defecto es `origin/main` al momento del smoke. Si otra sesión mergea mientras corre, o si el merge es solo docs y la web no se redespliega (no hay `ignoreCommand` hoy: no existe `vercel.json`, así que cada merge despliega; pero el proyecto Vercel puede tener «Ignored Build Step» configurado en el panel, no verificable desde el repo), el smoke espera 10 min y falla con un mensaje que parece un despliegue roto. No es falso verde, es ruido operativo.
Propuesta: documentar en `docs/ENTORNOS.md` y en AGENTS.md §3.2 que ante un merge posterior se usa `--expect-sha <sha del merge propio>`, y confirmar en el panel de Vercel que no hay build ignorado. Es una línea de doc, no de código.

### P3

**P3-1. `AYR_BUILT_AT: new Date().toISOString()` en `next.config.ts:9-10` cambia la configuración en cada build.** Next incorpora la config (incluido `env`) en el hash de la caché de webpack y en lo que inlinea; cada build ve un `env` distinto y puede invalidar la caché de `.next/cache` que Vercel restaura (builds más lentos), y vuelve el bundle no determinista. No produce sha viejo ni falso verde: el `sha` se inlinea de `VERCEL_GIT_COMMIT_SHA`, que ya está declarado en `turbo.json#tasks.build.env` (`:24`), así que turbo no reutiliza una salida de otro commit. Verificado: la referencia en `version/route.ts` es literal (`process.env.AYR_BUILD_SHA`), que es la forma que Next reemplaza con `env`.
Propuesta (opcional): quitar `builtAt` o tomarlo de otra fuente estable por commit; si se queda, medir el tiempo de build en Vercel antes y después.

**P3-2. Si producción publica `sha: "dev"` (variable ausente en el build) el smoke gasta 10 min en reintentar algo que no va a cambiar.** `waitForSha` trata «dev» como «todavía no». Propuesta: salir temprano con un mensaje específico («la web no trae VERCEL_GIT_COMMIT_SHA») si la respuesta es exactamente `dev` en dos intentos seguidos.

**P3-3. Con la web sin coincidir, el smoke igual sigue y crea/borra el admin efímero en producción** (`smoke-prod.mjs:106-134` solo cuenta `failures`; el resultado final es exit 1, correcto). Es inocuo (el `finally` lo limpia), pero se podría abortar antes de tocar la BD cuando falla la versión. Opcional.

**P3-4. Divulgación mínima.** `/version` y `/api/health` publican el sha del commit y `builtAt` sin sesión. No hay secretos ni datos de negocio; el riesgo es solo revelar a un tercero qué commit corre (útil para correlacionar con vulnerabilidades conocidas si el repo fuera público). Aceptable y coherente con D-636; se anota por completitud.

**P3-5. Cobertura de pruebas.** Los tests unitarios (`smoke-version.test.mjs`, `health.controller.spec.ts`, `build-info.spec.ts`) cubren bien el emparejamiento de sha, reintentos, tope y mensaje. No hay prueba del orquestador `smoke-prod.mjs` (corre al importarse; lo razonable) ni de que `OPEN_PATHS` no abra rutas hermanas; el E2E `version-d636.spec.ts` cubre `/version` con y sin sesión. El caso `/version/` o `/version?x=1` no se prueba (Next normaliza la barra final con 308 antes del middleware; la query no afecta `pathname`). Sin acción obligatoria.

## Revisado sin hallazgos

- **Middleware** (`apps/web/src/middleware.ts`): `OPEN_PATHS.includes(pathname)` es igualdad exacta; no abre `/version/x` ni prefijos. El `matcher` incluye `/version` (solo excluye `api`, `_next/*`, favicon e imágenes), así que la excepción sí se ejecuta, y con sesión no redirige a `/`. Antes de la excepción no se toca ninguna cookie.
- **Caché**: ruta `force-dynamic` + `Cache-Control: no-store`; el cliente del smoke manda `cache: 'no-store'` y `Cache-Control: no-cache`. `/api/health` pasa por el proxy `apps/web/src/app/api/[...path]/route.ts`, también `force-dynamic` y `cache: 'no-store'`, así que no hay copia de la CDN de Vercel. Los encabezados globales de `next.config.ts` (X-Frame-Options, etc.) no pisan `Cache-Control`.
- **Turbo**: `VERCEL_GIT_COMMIT_SHA` en `tasks.build.env` evita que un hit de caché devuelva el build de otro commit y deja pasar la variable bajo el modo estricto de env. Una salida cacheada de un build idéntico del mismo sha es correcta.
- **Inlineado de `env`**: `next.config.ts#env` se reemplaza en tiempo de compilación solo para accesos literales `process.env.NOMBRE`; `version/route.ts` los usa literales y `buildInfo` recibe el objeto, así que no se rompe por lectura dinámica. En local/CI el valor es `''`, que `present()` convierte en `dev`.
- **API**: `GIT_SHA` se agrega a `ENV_VARS` de `deploy-api.mjs` con el mismo `gitSha` (`rev-parse --short HEAD`) que el label (`:145`); el volcado a YAML entre comillas es seguro para un hex. No hay otro consumidor de `GIT_SHA` ni validación de entorno estricta que lo rechace. Una vuelta atrás con `update-traffic` a la revisión previa trae su propio `GIT_SHA`, coherente con su label. `deployedSha` tolera vacío y espacios.
- **Smoke**: `shaMatches` exige 7-40 hex y prefijo en cualquier sentido (corto 8 vs largo 40); «dev», vacío o no-sha nunca coinciden, así que no hay falso verde por valores basura. `argValue` falla ruidosamente con un sha inválido o una bandera sin valor (incluida `--expect-sha --base-url`). Comparación de la API solo con `--expect-api-sha`, tal como se declaró; sin ella lo dice en el `ok`. `run('git', ...)` lanza con mensaje filtrado si el `fetch` o el `rev-parse` fallan, antes de tocar producción. `PRODUCTION_WEB_HOSTS` es lista cerrada, no se puede apuntar el chequeo a un host ajeno.
- **Docs**: AGENTS.md §3.2, `ayr-cierre`, `ayr-ventana` y `docs/ENTORNOS.md` dicen lo mismo (10 min, dos dominios, `--expect-sha`, `--expect-api-sha`). Un detalle menor: `ayr-ventana` paso 7 todavía habla de push con `AYR_OWNER_PUSH=1`, anterior a este corte y fuera de alcance.
- **CI**: `pnpm test:scripts` ya recoge `scripts/*.test.mjs` (`.github/workflows/ci.yml:36`), así que los tests nuevos corren.
