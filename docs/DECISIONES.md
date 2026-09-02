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
