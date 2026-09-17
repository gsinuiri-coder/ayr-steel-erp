# Impacto en runtime de las variables rotas de Cloud Run

Sesión RF-S2-INTEGRA / M4, 2026-09-16. **Solo lectura de código** sobre `rf-s2` rebaseada en
`origin/main` (`ae5bb1c`, runtime idéntico a `ca6314d`). No se tocó Cloud Run ni ningún secreto,
y no se usaron credenciales de producción.

## Contexto

La revisión activa de `ayr-steel-erp-api` no tiene `NODE_ENV`, `WEB_ORIGIN` ni `JOBS_ENABLED`.
Tiene una sola variable cuyo nombre es literalmente `"^|^NODE_ENV`, y el resto de la lista quedó
en su valor. La causa está documentada en `docs/PROGRESO.md` (Incidente HOTFIX-DESFASE, hallazgo
colateral): `scripts/deploy-api.mjs` pasa `--set-env-vars ^|^…` por `cmd /c` y el delimitador
llega con comillas. Para el API, las tres variables **no existen**: rige lo que venga de la
imagen o del default de `apps/api/src/config/env.ts`.

El brief supone `NODE_ENV=development`. **No es lo que corre**: el `Dockerfile` (etapa `runtime`)
fija `ENV NODE_ENV=production`, y como Cloud Run no define ninguna variable con ese nombre, el
valor de la imagen queda en pie. Abajo se analiza cada variable dos veces: con el valor que de
verdad corre y con el hipotético del brief, que es lo que pasaría si alguien sacara esa línea
del `Dockerfile`.

| Variable       | Valor efectivo hoy      | De dónde sale                            |
| -------------- | ----------------------- | ---------------------------------------- |
| `NODE_ENV`     | `production`            | `Dockerfile` → `ENV NODE_ENV=production` |
| `WEB_ORIGIN`   | `http://localhost:3001` | default de `env.ts`                      |
| `JOBS_ENABLED` | `true`                  | default de `env.ts`                      |

## Hallazgos

### 1. `NODE_ENV` → cookies `Secure` — TOLERABLE (con una fragilidad para S3)

- **Único uso en runtime:** `loadEnv` calcula `isProduction` y de ahí
  `cookieSecure = COOKIE_SECURE ?? isProduction` (`apps/api/src/config/env.ts`). `cookieSecure` se usa en
  `apps/api/src/auth/cookies.ts#baseOptions`: `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`
  y `secure: env.cookieSecure`. `isProduction` no se lee en ningún otro lugar de
  `apps/api/src` (grep de `isProduction`/`NODE_ENV`/`process.env`, sin specs).
- **Hoy:** `production` por la imagen → cookies `Secure`. **Sin impacto.**
- **Con `development` (hipotético):** las cookies de acceso y de refresh saldrían sin `Secure`.
  El web está bajo HTTPS (`v2.mareliac.pe`), así que el navegador igual las manda solo por
  HTTPS en la práctica, pero un `http://` al dominio (antes del redirect a HTTPS) las expondría
  en claro. `httpOnly` y `sameSite` no dependen de `NODE_ENV`.
- **Express:** `app.get('env')` también lee `NODE_ENV`, y solo cambia el HTML de error del
  `finalhandler` por defecto. Nest atrapa todas las excepciones de sus rutas con su propio
  filtro, que responde JSON y no incluye el stack. Sin impacto en ninguno de los dos casos.
- **Por qué tolerable:** hoy el valor es el correcto. La fragilidad es que lo único que sostiene
  `Secure` es una línea del `Dockerfile`. **Para S3:** cuando se arregle `deploy-api.mjs`,
  definir `COOKIE_SECURE=true` explícito en Cloud Run (gana sobre `isProduction`), y que la
  verificación post-deploy compare los nombres de las variables contra la lista esperada.

### 2. `WEB_ORIGIN` → CORS — TOLERABLE

- **Uso:** `apps/api/src/main.ts` → `app.enableCors({ origin: env.webOrigins, credentials: true })`.
  Es el único uso.
- **Hoy:** CORS acepta, con credenciales, solo a `http://localhost:3001` y rechaza a
  `https://v2.mareliac.pe`, que no recibe `Access-Control-Allow-Origin` (verificado con un
  preflight en la ventana HOTFIX-DESFASE).
- **Impacto funcional: ninguno.** El navegador nunca llama al API directo: todo pasa por el
  rewrite server-side `/api/*` de Next (D-015/D-022), y ahí no hay CORS de por medio. Si el web
  dependiera de CORS, producción estaría rota desde `00029-n7q` (2026-09-10), y no lo está.
- **Seguridad:** que se acepte `localhost:3001` con `credentials: true` no expone sesiones. Las
  cookies de sesión son host-only del dominio del web (se fijan a través del rewrite, sin
  `domain`), así que el navegador no las adjunta a una petición a `*.run.app`. Una página
  maliciosa servida en `localhost:3001` en la máquina de un usuario solo puede hacer lo mismo
  que un `curl` sin sesión: login con credenciales que ya tenga, o rutas `@Public()`, que son
  `health` y `auth`. Sigue activo el rate limit (`THROTTLE_DISABLED` no está definida, así que
  vale `false`).
- **Con `development` (hipotético):** `NODE_ENV` no participa en CORS; el caso no cambia.
- **Para S3:** fijar `WEB_ORIGIN=https://v2.mareliac.pe` (o sacar CORS del todo, si se confirma
  que ningún cliente llama directo al API).

### 3. `JOBS_ENABLED` → pg-boss — TOLERABLE (sin impacto)

- **Uso:** `jobs/jobs.service.ts` (arranca pg-boss), `sales/quotation-expiry.job.ts` (cron diario
  05:00 UTC) e `invoicing/invoicing-send.job.ts` (cron cada 15 min más un barrido al arrancar).
- **Hoy:** el default es `true`, que es justo el valor que `deploy-api.mjs` quería fijar.
  **Sin impacto.**
- **¿Jobs duplicados?** No por esta variable: vale lo mismo que el deploy pretendía. Con varias
  instancias de Cloud Run, cada una registra el `work` y el `schedule`. `schedule` se guarda por
  nombre de cola (reprogramarlo no crea un segundo cron) y el `fetch` de pg-boss 12 toma trabajos
  con `SKIP LOCKED`, así que un mismo job no lo procesan dos instancias. Esto sale de cómo está
  diseñado pg-boss, **no se verificó en runtime**.
- **El barrido de arranque** (`InvoicingSendJob.onModuleInit` → `sendPending()`) corre en cada
  instancia que arranca, fuera de la cola. Hoy es un no-op: `sendPending` sale con 0 si
  `PSE_ENABLED` no es `true` (D-216), que es el estado de producción. **Para cuando se encienda el
  PSE** (fuera del alcance de esta variable): revisar que dos arranques simultáneos no reintenten
  el mismo documento. Queda como nota, no como hallazgo de las variables rotas.
- **Escalado a cero:** una instancia dormida no ejecuta crons (ya documentado en los dos jobs;
  hay endpoints manuales). No depende de estas variables.

### 4. Rutas de test, reset o purga expuestas — NINGUNA

- Los 25 `@Controller` de `apps/api/src` son de dominio, más `health` y `auth`. No hay Swagger ni
  rutas `test`/`e2e`/`seed`/`reset`/`purge`, y ninguna ruta se registra según `NODE_ENV`.
- El reset y la purga viven fuera del runtime: `apps/api/prisma/reset-test-db.ts` y
  `test-db-guard.ts` (lista blanca por URL de base, **no** por `NODE_ENV`), `e2e/global-setup.ts`
  y `scripts/`. `apps/api/tsconfig.build.json` excluye `prisma`, así que no entran en `dist/`, y
  la imagen arranca con `node dist/main.js`. La carpeta `prisma/` que se copia a la imagen trae
  solo `.ts` sin compilar y sin `ts-node`: no se pueden ejecutar ahí.
- `ALLOW_DB_RESET` y `E2E_RESET_DB` solo los leen la suite y los scripts, nunca el API.

### 5. Logs — SIN IMPACTO

- El `Logger` de Nest no cambia de nivel ni de formato según `NODE_ENV`: `bufferLogs: true` en
  `main.ts`, y no se configura ningún nivel por entorno. Prisma no tiene `log` de consultas
  configurado. `requestIdMiddleware` (D-218, nuevo en `rf-s2`) no lee ninguna variable.
- El valor de la variable rota (`WEB_ORIGIN=…|JOBS_ENABLED=true`) no es secreto y el API no lo
  lee ni lo loguea.

## Clasificación

| #   | Hallazgo                                              | Clasificación                   | Cuándo                                                  |
| --- | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| 1   | `Secure` de las cookies depende solo del `Dockerfile` | Tolerable                       | S3: `COOKIE_SECURE=true` explícito + chequeo de nombres |
| 2   | CORS en `localhost:3001`                              | Tolerable                       | S3: `WEB_ORIGIN` real o sacar CORS                      |
| 3   | `JOBS_ENABLED` por default                            | Tolerable (sin impacto)         | S3, junto con el arreglo de `deploy-api.mjs`            |
| 3b  | Barrido de arranque de `sendPending` por instancia    | Nota (no es de estas variables) | Antes de encender `PSE_ENABLED` en producción           |
| 4   | Rutas de test/reset/purga                             | Sin hallazgo                    | —                                                       |
| 5   | Logs                                                  | Sin hallazgo                    | —                                                       |

**Nada grave: ningún hallazgo bloquea la ventana de `rf-s2`.** `rf-s2` no agrega ninguna
dependencia nueva de estas variables (el diff contra `origin/main` en `apps/api/src` no lee
`env` fuera del `main.ts` que ya existía).

## Condición para la ventana de `rf-s2`

Una sola, de procedimiento: **desplegar el API como en la ventana RF-S1+HOTFIX**
(`gcloud run deploy --source .` con `--update-labels git-sha=<sha>` y **sin** flags de
variables ni de secretos), **no** con `pnpm deploy:api`. `deploy-api.mjs` volvería a escribir la
variable rota con `--set-env-vars` y, en el peor caso, a reemplazar la lista de variables. El
arreglo de fondo (`--env-vars-file` + verificación de nombres) sigue en la deuda S3.
