# Decisiones de arquitectura (formato largo)

> Espejo de `ARQUITECTURA.md` §0.2. Aquí solo van las decisiones que necesitan contexto adicional (alternativas evaluadas, consecuencias). La tabla corta de §0.2 sigue siendo la fuente de verdad del listado.

## D-015 — El web consume el API por proxy same-origin (`/api/*`)

**Fecha:** 2026-09-02. **Actualizada:** 2026-09-02 (mecanismo, ver D-022 — la decisión de fondo no cambia).

**Contexto.** D-010 fija cookies httpOnly para access/refresh. Web (Vercel) y API (Cloud Run) viven en dominios distintos. Cookies de terceros con `SameSite=None` dependen del navegador y Safari/Chrome las restringen cada vez más; además obligan a CORS con credenciales en cada request.

**Decisión.** El navegador solo habla con su propio origen bajo `/api/*`; el web reenvía la petición al API real y pasa de vuelta las cabeceras `Set-Cookie`. Las cookies del API no fijan `domain` y usan `SameSite=Lax`. El API igual habilita CORS para `WEB_ORIGIN` (útil para herramientas y para llamar directo en desarrollo).

**Consecuencias.** Un salto extra por request (Vercel → Cloud Run). Server Components de Next llaman al API directo por `API_URL` reenviando la cookie de la petición entrante. Playwright local usa la misma ruta `/api/*`.

**Nota (2026-09-02):** la implementación original usaba `rewrites()` de `next.config.ts`; se cambió a un Route Handler por el problema descrito en D-022. El objetivo y el contrato (`/api/*` same-origin, cookies sin `domain`) no cambiaron.

## D-016 — Rama de producción de Neon se llama `production`

**Fecha:** 2026-09-02

D-005 decía `main`. El proyecto Neon ya venía creado con la rama por defecto `production`; renombrarla no aporta nada y cambiar la rama por defecto es una operación manual. Se mantiene `production` como prod y se documenta. `dev` y `ci` cuelgan de `production`.

## D-017 — Versiones fijadas en Fase 0

**Fecha:** 2026-09-02

NestJS 11.2 (existe 12 pero el alcance pide 11), Next 15.5 (existe 16), Prisma 6.19 (7 cambia a `prisma.config.ts` + driver adapters; se migrará cuando haya un motivo), TypeScript 5.9 (7 es el port a Go y no todo el tooling lo soporta), ESLint 9 flat config, Zod 3.25 (API v3; `zod/v4` disponible en el mismo paquete), Jest 29 con ts-jest (encaja con el template de NestJS; Vitest queda para el web si algún día hace falta). Versiones exactas, sin `^`, para que dos instalaciones den lo mismo.

## D-022 — El proxy `/api/*` es un Route Handler, no un `rewrites()` de Next

**Fecha:** 2026-09-02

**Contexto.** D-015 exige que el web hable con el API por `/api/*` same-origin. La primera implementación usó `rewrites()` en `next.config.ts` apuntando al dominio por defecto de Cloud Run (`https://<servicio>-<hash>-uc.a.run.app`). Funcionaba contra `localhost` y en el build, pero en producción (Vercel) toda petición a `/api/*` devolvía 404 con el código de error `DNS_HOSTNAME_RESOLVED_PRIVATE`.

**Diagnóstico.** Las IPs de Cloud Run (`34.143.x.x` / `2600:1900:...::`) son públicas y resuelven igual desde cualquier resolutor DNS público (se verificó con DNS-over-HTTPS de Google). El bloqueo es de Vercel: su motor de `rewrites()`/`redirects()` hacia hosts externos aplica una protección anti-SSRF que, contra el dominio por defecto de Cloud Run, da un falso positivo. Mapear un dominio propio al servicio de Cloud Run habría evitado el problema, pero exige verificación de dominio (Search Console) y no hay uno disponible para el API en esta fase.

**Decisión.** Se reemplazó el `rewrites()` por un Route Handler catch-all: `apps/web/src/app/api/[...path]/route.ts`, con `export const runtime = 'nodejs'`. Hace un `fetch()` server-side hacia `API_URL` reenviando método, headers (menos los hop-by-hop), body y query string, y devuelve la respuesta tal cual, incluyendo cada `Set-Cookie` por separado (`Headers.getSetCookie()`, no el `Headers` estándar que los colapsa en uno). Un `fetch` normal dentro de una función no pasa por el chequeo anti-SSRF de `rewrites()`.

**Consecuencias.** Cada request a `/api/*` ahora invoca una función serverless de Vercel (antes era un rewrite de borde, más barato); latencia y cold starts algo mayores, aceptable para el volumen de este proyecto. El contrato (`/api/*` same-origin, cookies sin `domain`) no cambia. `next.config.ts` quedó sin `rewrites()`.

## D-023 — IAM explícito para la service account de Compute (Cloud Build + Secret Manager)

**Fecha:** 2026-09-02

**Contexto.** `gcloud run deploy --source .` usa la service account de Compute por defecto (`<project-number>-compute@developer.gserviceaccount.com`) tanto para que Cloud Build compile la imagen como para que la revisión de Cloud Run corra. Esa cuenta ya tenía `roles/editor` a nivel de proyecto (rol heredado del proyecto GCP).

**Problema.** Con solo `roles/editor` el deploy falló en dos puntos distintos:

1. Cloud Build no pudo leer el zip fuente subido al bucket `run-sources-<project>-<region>` (`PERMISSION_DENIED` en `storage.googleapis.com`).
2. Ya con la imagen construida, la revisión de Cloud Run no pudo leer los secretos de `DATABASE_URL`, `DIRECT_URL` y `JWT_SECRET` desde Secret Manager (`Permission denied on secret ... roles/secretmanager.secretAccessor`).

`roles/editor` no incluye acceso a Secret Manager por diseño (es un rol "básico" legado que excluye IAM y algunos servicios sensibles), y el acceso al bucket de fuentes de Cloud Build requiere roles específicos que tampoco cubre por completo en cuentas nuevas.

**Decisión.** `scripts/gcp-secrets.mjs` (que ya corre antes del primer deploy) ahora también:

- otorga `roles/secretmanager.secretAccessor` sobre cada secreto individualmente a la service account de Compute;
- otorga a nivel de proyecto `roles/storage.objectViewer`, `roles/cloudbuild.builds.builder`, `roles/artifactregistry.writer` y `roles/logging.logWriter` a esa misma cuenta.

Todas las llamadas son idempotentes (`add-iam-policy-binding` no duplica si el binding ya existe), así que correr el script varias veces es seguro.

**Consecuencias.** Un proyecto GCP nuevo con facturación recién vinculada debería poder desplegar con `pnpm deploy:api` sin pasos manuales de IAM. Si Google cambia qué rol usa por defecto para builds de Cloud Run en el futuro, revisar este script primero.

## D-024 — E2E de escritura contra producción con administrador efímero

**Fecha:** 2026-09-02

**Contexto.** El cierre de Fase 0 exige que los cuatro escenarios de autenticación pasen contra la URL de producción, no solo en local/CI: login correcto, login fallido, usuario desactivado no entra y cambio de rol invalida la sesión (RF-01, RF-03). Los dos últimos necesitan crear un usuario, desactivarlo y cambiarle el rol vía API; hasta ahora se auto-excluían en producción (`test.skip(isProduction)`) y allí solo corrían los tres de solo lectura.

**Problema.** Correrlos en producción choca con dos cosas:

1. El administrador real (`ADMIN_EMAIL`) se siembra con `mustChangePassword = true`, y el `AuthGuard` le bloquea todo salvo `/auth/me`, `/auth/change-password` y `/auth/logout`. Usarlo obligaría a consumir su cambio de contraseña obligatorio, es decir, alterar la cuenta del dueño.
2. Los usuarios se dan de baja de forma lógica (nunca `DELETE`), así que cada corrida dejaría cuentas `e2e-...` visibles en `/usuarios` para el cliente.

**Alternativas descartadas.** (a) Dejar solo los tres tests de lectura en producción: no cumple el criterio de cierre y deja RF-03 sin verificar donde importa. (b) Usar la cuenta real cambiándole la contraseña: modifica una credencial del dueño desde un test. (c) Un administrador de pruebas permanente en producción: una cuenta privilegiada extra viva de forma indefinida.

**Decisión.** `pnpm e2e:prod` (`scripts/e2e-prod.mjs`) orquesta la corrida:

1. genera una contraseña aleatoria que solo vive en memoria y en el entorno del proceso hijo;
2. crea el administrador efímero `e2e-admin@ayr.test` con `mustChangePassword = false` (`apps/api/prisma/e2e-admin.ts`, exige `ALLOW_E2E_ADMIN=1`);
3. corre `e2e/tests/auth.spec.ts` con `E2E_ALLOW_WRITES=1`, que es lo que levanta el `test.skip` de los escenarios de escritura;
4. en `finally` —también si los tests fallan— borra todo usuario que cumpla el patrón `e2e-...@ayr.test` (`apps/api/prisma/cleanup-e2e-users.ts`, exige `ALLOW_E2E_CLEANUP=1`).

El patrón de correos vive en un único módulo (`apps/api/prisma/e2e-users.ts`) que comparten la creación y la limpieza, y la limpieza vuelve a filtrar en código lo que ya filtró en SQL: si ambos criterios divergieran, aborta en vez de borrar de más. Crear el admin efímero con un correo fuera del patrón también falla de entrada, porque la limpieza no lo alcanzaría.

**Consecuencias.** Las sesiones de los usuarios borrados caen por `onDelete: Cascade`. `audit_log` **no** se toca: es append-only (RF-95) y sus filas quedan como registro de lo ocurrido aunque el usuario ya no exista — tras la primera corrida verificada quedaron en producción `users.create=3`, `users.deactivate=1` y `users.role.change=1`, que es justamente la evidencia de que RF-03 se probó de verdad. La cuenta del dueño no se usa ni se modifica. `pnpm e2e` (local) y CI no cambian: allí no hay `E2E_BASE_URL`, así que los escenarios de escritura siguen corriendo siempre.

## D-025..D-034 — Cierre de las preguntas abiertas P-02..P-10 (arranque de Fase 1)

**Fecha:** 2026-09-03

**Nota de numeración.** El arranque de Fase 1 traía instrucciones para registrar estas decisiones como `D-024..D-033`, pero `D-024` ya estaba tomado por el cierre de Fase 0 (E2E efímero, arriba). Se corrieron todos los IDs una posición: `D-025..D-034`. El contenido y el orden de las decisiones no cambian, solo el número.

**P-04 (D-027) — la decisión final difiere de la recomendación original.** §5 recomendaba vender la bobina por su código, sin generar SKU de catálogo. Al modelar el catálogo junto con clientes/proveedores/precios de esta misma fase, mantener dos formas distintas de "cosa vendible" (producto de catálogo vs. bobina suelta) habría duplicado listados, búsquedas y el futuro cálculo de precio sugerido (D-032). Se optó por generar igual un `product` de línea `trading` con SKU determinístico `BOB-{finishCode}-{thicknessMm}-{widthMm}` (agrupa por tipo, no por bobina individual — varias bobinas del mismo acabado/espesor/ancho comparten SKU), y la venta sigue grabando qué bobina concreta se descontó en el kardex. Esto se implementa recién en Fase 2 (cuando existen bobinas); en Fase 1 solo queda registrada la decisión y el patrón de SKU.

**P-06 (D-029) — idem, la recomendación original era solo TC manual.** Al confirmarse que la empresa ya cuenta con un token de apis.net.pe (`APIS_NET_PE_TOKEN`, en `.env.setup`), se prefirió automatizar el tipo de cambio SUNAT del día con `exchange-rates.getRate(date, currency)`: busca primero en la tabla `exchange_rates` (caché), si no existe consulta apis.net.pe y la guarda con `source=API`, y si la consulta externa falla cae al último tipo de cambio conocido para esa moneda, marcado editable a mano (`source=MANUAL`). Cada compra/venta guarda su propio `exchangeRate`, `exchangeRateSource` y `exchangeRateDate` en el momento de la operación, para que un TC corregido después no reescriba operaciones ya cerradas.

**P-09 (D-032) — idem, la recomendación original era lista de precios por producto.** Mantener una lista de precios manual por producto exige mantenimiento constante y no refleja el costo real de kardex. Se prefirió un precio *sugerido* calculado (costo promedio ponderado × (1 + margen% de la línea)), con margen y margen mínimo configurables solo por ADMINISTRADOR en `pricing_settings`. El vendedor ve el sugerido, puede subirlo libremente, y si intenta bajarlo del margen mínimo el guard exige rol ADMINISTRADOR. Esto reemplaza la idea de "lista fija" por un piso dinámico; se implementa en el módulo `pricing` de Fase 1 aunque su consumo real (cotizaciones) es de Fase 5.

**P-07 (D-030) — el módulo de compras se especifica ahora, se construye en Fase 2.** La reorganización de fases (D-034) mueve "bobinas" a Fase 2 junto con "compras", porque toda entrada de bobina o producto terminado a inventario debería nacer de una compra recibida (trazabilidad de costo real para el kardex de D-028). Registrar la decisión ahora evita que Fase 2 tenga que reabrir preguntas de diseño ya resueltas aquí.
